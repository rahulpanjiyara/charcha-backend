import { randomUUID } from "node:crypto";
import type { Server as SocketIoServer, Socket } from "socket.io";
import Conversation from "../modals/Conversation.js";
import User from "../modals/User.js";

type PendingCall = {
  callId: string;
  conversationId: string;
  callerId: string;
  calleeId: string;
  roomName: string;
  timeout: NodeJS.Timeout;
};

const pendingCalls = new Map<string, PendingCall>();

function emitToUser(io: SocketIoServer, userId: string, event: string, payload: unknown) {
  for (const client of io.sockets.sockets.values()) {
    if (String(client.data.userId) === userId) client.emit(event, payload);
  }
}

export function registerCallEvents(socket: Socket, io: SocketIoServer) {
  socket.on("startVideoCall", async (data: { conversationId?: string }) => {
    try {
      const callerId = String(socket.data.userId);
      const conversation = await Conversation.findOne({
        _id: data?.conversationId,
        type: "direct",
        participants: callerId,
      }).lean();

      if (!conversation) {
        return socket.emit("callFailed", { success: false, msg: "Video calls are available in direct chats only" });
      }

      const calleeId = conversation.participants
        .map((participant) => participant.toString())
        .find((participantId) => participantId !== callerId);
      if (!calleeId) return socket.emit("callFailed", { success: false, msg: "Friend not found" });

      const recipientOnline = Array.from(io.sockets.sockets.values()).some(
        (client) => client.connected && String(client.data.userId) === calleeId
      );
      if (!recipientOnline) {
        return socket.emit("callFailed", { success: false, msg: "This friend is currently offline" });
      }

      const caller = await User.findById(callerId).select("name avatar").lean();
      const callId = randomUUID();
      const roomName = `charcha-${randomUUID()}`;
      const timeout = setTimeout(() => {
        const call = pendingCalls.get(callId);
        if (!call) return;
        emitToUser(io, callerId, "callDeclined", { callId, reason: "No answer" });
        emitToUser(io, calleeId, "callEnded", { callId, reason: "Missed call" });
        pendingCalls.delete(callId);
      }, 45_000);

      pendingCalls.set(callId, {
        callId,
        conversationId: conversation._id.toString(),
        callerId,
        calleeId,
        roomName,
        timeout,
      });

      socket.emit("callStarted", { success: true, data: { callId } });
      emitToUser(io, calleeId, "incomingVideoCall", {
        callId,
        conversationId: conversation._id.toString(),
        caller: {
          id: callerId,
          name: caller?.name || socket.data.user?.name || "Friend",
          avatar: caller?.avatar || null,
        },
      });
    } catch (error) {
      console.error("Failed to start video call", error);
      socket.emit("callFailed", { success: false, msg: "Could not start the video call" });
    }
  });

  socket.on("respondVideoCall", (data: { callId?: string; accepted?: boolean }) => {
    const call = data?.callId ? pendingCalls.get(data.callId) : null;
    const userId = String(socket.data.userId);
    if (!call || call.calleeId !== userId) {
      return socket.emit("callFailed", { success: false, msg: "This call is no longer available" });
    }

    clearTimeout(call.timeout);
    if (!data.accepted) {
      emitToUser(io, call.callerId, "callDeclined", { callId: call.callId, reason: "Call declined" });
      emitToUser(io, call.calleeId, "callEnded", { callId: call.callId, reason: "Call declined" });
      pendingCalls.delete(call.callId);
      return;
    }

    const payload = {
      callId: call.callId,
      conversationId: call.conversationId,
      roomUrl: `https://meet.jit.si/${call.roomName}`,
    };
    emitToUser(io, call.callerId, "callAccepted", payload);
    emitToUser(io, call.calleeId, "callAccepted", payload);
  });

  socket.on("endVideoCall", (data: { callId?: string }) => {
    const call = data?.callId ? pendingCalls.get(data.callId) : null;
    const userId = String(socket.data.userId);
    if (!call || (call.callerId !== userId && call.calleeId !== userId)) return;

    clearTimeout(call.timeout);
    const otherUserId = call.callerId === userId ? call.calleeId : call.callerId;
    emitToUser(io, otherUserId, "callEnded", { callId: call.callId, reason: "Call ended" });
    pendingCalls.delete(call.callId);
  });
}
