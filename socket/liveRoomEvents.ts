import { randomUUID } from "node:crypto";
import type { Server as SocketIoServer, Socket } from "socket.io";
import FriendRequest from "../modals/FriendRequest.js";
import User from "../modals/User.js";
import { createActivities } from "../utils/notifications.js";

type RoomParticipant = { id: string; name: string; avatar: string };
type LiveRoom = {
  id: string;
  title: string;
  hostId: string;
  roomType: "audio" | "video";
  participants: Map<string, RoomParticipant>;
  createdAt: Date;
};

const liveRooms = new Map<string, LiveRoom>();
const AUDIO_ROOM_CAPACITY = 4;
const VIDEO_ROOM_CAPACITY = 4;
const roomCapacity = (roomType: LiveRoom["roomType"]) => roomType === "video" ? VIDEO_ROOM_CAPACITY : AUDIO_ROOM_CAPACITY;

function emitToUser(io: SocketIoServer, userId: string, event: string, payload: unknown) {
  for (const client of io.sockets.sockets.values()) {
    if (String(client.data.userId) === userId) client.emit(event, payload);
  }
}

async function friendIdsFor(userId: string) {
  const relationships = await FriendRequest.find({
    status: "accepted",
    $or: [{ sender: userId }, { recipient: userId }],
  }).lean();
  return relationships.map((request) => request.sender.toString() === userId ? request.recipient.toString() : request.sender.toString());
}

const roomPayload = (room: LiveRoom) => ({
  id: room.id,
  title: room.title,
  hostId: room.hostId,
  roomType: room.roomType,
  participants: [...room.participants.values()],
  participantCount: room.participants.size,
  maxParticipants: roomCapacity(room.roomType),
  createdAt: room.createdAt,
});

function emitRoomsChanged(io: SocketIoServer) {
  io.emit("liveRoomsChanged", { success: true });
}

function leaveRoom(io: SocketIoServer, room: LiveRoom, userId: string) {
  if (!room.participants.has(userId)) return;
  room.participants.delete(userId);
  if (room.hostId === userId || room.participants.size === 0) {
    for (const participantId of room.participants.keys()) emitToUser(io, participantId, "liveRoomEnded", { roomId: room.id });
    liveRooms.delete(room.id);
  } else {
    for (const participantId of room.participants.keys()) emitToUser(io, participantId, "liveRoomPeerLeft", { roomId: room.id, userId });
  }
  emitRoomsChanged(io);
}

export function registerLiveRoomEvents(socket: Socket, io: SocketIoServer) {
  socket.on("getLiveRooms", async () => {
    try {
      const userId = String(socket.data.userId);
      const friendIds = new Set(await friendIdsFor(userId));
      const visible = [...liveRooms.values()]
        .filter((room) => room.hostId === userId || room.participants.has(userId) || friendIds.has(room.hostId))
        .map(roomPayload);
      socket.emit("getLiveRooms", { success: true, data: visible });
    } catch (error) {
      console.error("getLiveRooms error", error);
      socket.emit("getLiveRooms", { success: false, msg: "Could not load Live Rooms" });
    }
  });

  socket.on("createLiveRoom", async (data: { title?: string; roomType?: "audio" | "video" }) => {
    try {
      const userId = String(socket.data.userId);
      const existing = [...liveRooms.values()].find((room) => room.participants.has(userId));
      if (existing) return socket.emit("createLiveRoom", { success: false, msg: "Leave your current room first" });
      const title = String(data?.title || "").trim().slice(0, 80);
      const roomType: LiveRoom["roomType"] = data?.roomType === "video" ? "video" : "audio";
      if (!title) return socket.emit("createLiveRoom", { success: false, msg: "Give your room a title" });
      const user = await User.findById(userId).select("name avatar").lean();
      if (!user) return socket.emit("createLiveRoom", { success: false, msg: "User not found" });
      const room: LiveRoom = {
        id: randomUUID(),
        title,
        hostId: userId,
        roomType,
        participants: new Map([[userId, { id: userId, name: user.name || "Friend", avatar: user.avatar || "" }]]),
        createdAt: new Date(),
      };
      liveRooms.set(room.id, room);
      socket.emit("createLiveRoom", { success: true, data: roomPayload(room) });
      emitRoomsChanged(io);
      const friendIds = await friendIdsFor(userId);
      void createActivities({
        recipientIds: friendIds,
        actorId: userId,
        type: "live_room",
        title: "A Live Room is open",
        body: `${user.name} started a ${roomType} room · “${title}”`,
        data: { url: "/(main)/liveRooms", roomId: room.id },
      });
    } catch (error) {
      console.error("createLiveRoom error", error);
      socket.emit("createLiveRoom", { success: false, msg: "Could not start this room" });
    }
  });

  socket.on("joinLiveRoom", async (data: { roomId?: string }) => {
    try {
      const userId = String(socket.data.userId);
      const room = data?.roomId ? liveRooms.get(data.roomId) : null;
      if (!room) return socket.emit("joinLiveRoom", { success: false, msg: "This room has ended" });
      if (room.participants.has(userId)) return socket.emit("joinLiveRoom", { success: true, data: roomPayload(room) });
      if (room.participants.size >= roomCapacity(room.roomType)) return socket.emit("joinLiveRoom", { success: false, msg: "This room is full" });
      const friendIds = await friendIdsFor(room.hostId);
      if (!friendIds.includes(userId)) return socket.emit("joinLiveRoom", { success: false, msg: "This room is for the host’s friends" });
      const user = await User.findById(userId).select("name avatar").lean();
      if (!user) return socket.emit("joinLiveRoom", { success: false, msg: "User not found" });
      const participant = { id: userId, name: user.name || "Friend", avatar: user.avatar || "" };
      const existingIds = [...room.participants.keys()];
      room.participants.set(userId, participant);
      socket.emit("joinLiveRoom", { success: true, data: roomPayload(room) });
      for (const participantId of existingIds) emitToUser(io, participantId, "liveRoomPeerJoined", { roomId: room.id, participant });
      emitRoomsChanged(io);
    } catch (error) {
      console.error("joinLiveRoom error", error);
      socket.emit("joinLiveRoom", { success: false, msg: "Could not join this room" });
    }
  });

  socket.on("liveRoomSignal", (data: { roomId?: string; targetUserId?: string; type?: "offer" | "answer" | "ice"; payload?: unknown }) => {
    const userId = String(socket.data.userId);
    const room = data?.roomId ? liveRooms.get(data.roomId) : null;
    if (!room || !room.participants.has(userId) || !data.targetUserId || !room.participants.has(data.targetUserId)) return;
    if (!["offer", "answer", "ice"].includes(data.type || "")) return;
    emitToUser(io, data.targetUserId, "liveRoomSignal", { roomId: room.id, fromUserId: userId, type: data.type, payload: data.payload });
  });

  socket.on("leaveLiveRoom", (data: { roomId?: string }) => {
    const room = data?.roomId ? liveRooms.get(data.roomId) : null;
    if (room) leaveRoom(io, room, String(socket.data.userId));
    socket.emit("leaveLiveRoom", { success: true });
  });

  socket.on("disconnect", () => {
    const userId = String(socket.data.userId);
    for (const room of [...liveRooms.values()]) {
      if (room.participants.has(userId)) leaveRoom(io, room, userId);
    }
  });
}
