import { createHmac, randomUUID } from "node:crypto";
import type { Server as SocketIoServer, Socket } from "socket.io";
import Conversation from "../modals/Conversation.js";
import User from "../modals/User.js";
import { sendPushToUsers } from "../utils/notifications.js";

type PendingCall = {
  callId: string;
  conversationId: string;
  callerId: string;
  calleeId: string;
  caller: { id: string; name: string; avatar: string | null };
  callType: "audio" | "video";
  accepted: boolean;
  signalBacklog: Array<{
    signalId: string;
    fromUserId: string;
    toUserId: string;
    type: "offer" | "answer" | "ice";
    payload: unknown;
  }>;
  timeout: NodeJS.Timeout;
};

const pendingCalls = new Map<string, PendingCall>();

function emitToUser(io: SocketIoServer, userId: string, event: string, payload: unknown) {
  for (const client of io.sockets.sockets.values()) {
    if (String(client.data.userId) === userId) client.emit(event, payload);
  }
}

function hasConnectedClient(io: SocketIoServer, userId: string, exceptSocketId?: string) {
  for (const client of io.sockets.sockets.values()) {
    if (client.id !== exceptSocketId && client.connected && String(client.data.userId) === userId) return true;
  }
  return false;
}

export function registerCallEvents(socket: Socket, io: SocketIoServer) {
  socket.on("getIceServers", (acknowledge?: (response: unknown) => void) => {
    if (typeof acknowledge !== "function") return;

    const turnSecret = process.env.TURN_SECRET;
    const turnHost = process.env.TURN_HOST || "charcha.loan-master.cloud";
    const iceServers: Array<Record<string, unknown>> = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ];

    if (turnSecret) {
      const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
      const username = `${expiresAt}:${String(socket.data.userId)}`;
      const credential = createHmac("sha1", turnSecret)
        .update(username)
        .digest("base64");
      iceServers.push({
        urls: [
          `turn:${turnHost}:3478?transport=udp`,
          `turn:${turnHost}:3478?transport=tcp`,
        ],
        username,
        credential,
      });
    }

    acknowledge({ success: true, data: { iceServers } });
  });

  socket.on("startVideoCall", async (data: { conversationId?: string; callType?: "audio" | "video" }) => {
    try {
      const callerId = String(socket.data.userId);
      const callType = data?.callType === "audio" ? "audio" : "video";
      const conversation = await Conversation.findOne({
        _id: data?.conversationId,
        type: "direct",
        participants: callerId,
      }).lean();

      if (!conversation) {
        return socket.emit("callFailed", { success: false, msg: "Calls are available in direct chats only" });
      }

      const calleeId = conversation.participants
        .map((participant) => participant.toString())
        .find((participantId) => participantId !== callerId);
      if (!calleeId) return socket.emit("callFailed", { success: false, msg: "Friend not found" });

      const caller = await User.findById(callerId).select("name avatar").lean();
      const callerInfo = {
        id: callerId,
        name: caller?.name || socket.data.user?.name || "Friend",
        avatar: caller?.avatar || null,
      };
      const callId = randomUUID();
      const timeout = setTimeout(() => {
        const call = pendingCalls.get(callId);
        if (!call) return;
        emitToUser(io, callerId, "callDeclined", { callId, reason: "No answer" });
        emitToUser(io, calleeId, "callEnded", { callId, reason: "Missed call" });
        void sendPushToUsers(
          [calleeId],
          "Call ended",
          "Missed call",
          { type: "call_ended", callId, reason: "missed" },
          { headless: true, ttl: 45 },
        );
        pendingCalls.delete(callId);
      }, 45_000);

      pendingCalls.set(callId, {
        callId,
        conversationId: conversation._id.toString(),
        callerId,
        calleeId,
        caller: callerInfo,
        callType,
        accepted: false,
        signalBacklog: [],
        timeout,
      });

      socket.emit("callStarted", { success: true, data: { callId, callType } });
      emitToUser(io, calleeId, "incomingVideoCall", {
        callId,
        conversationId: conversation._id.toString(),
        caller: callerInfo,
        callType,
      });
      // A data-only push wakes the Android background task, which registers the
      // call with ConnectionService. Foreground clients use the socket UI.
      const callPushData = {
        type: `${callType}_call`,
        callId,
        conversationId: conversation._id.toString(),
        callType,
        callerId: callerInfo.id,
        callerName: callerInfo.name,
        callerAvatar: callerInfo.avatar,
      };
      await Promise.all([
        sendPushToUsers(
          [calleeId],
          `${callerInfo.name} is calling`,
          `Incoming ${callType === "audio" ? "voice" : "video"} call · Tap to answer`,
          callPushData,
          { headless: true, ttl: 45, tokenMode: "native" },
        ),
        sendPushToUsers(
          [calleeId],
          `${callerInfo.name} is calling`,
          `Incoming ${callType === "audio" ? "voice" : "video"} call · Tap to answer`,
          callPushData,
          { ttl: 45, tokenMode: "legacy" },
        ),
      ]);
    } catch (error) {
      console.error("Failed to start call", error);
      socket.emit("callFailed", { success: false, msg: "Could not start the call" });
    }
  });

  socket.on("resumeVideoCall", (data: { callId?: string; replaySignals?: boolean }) => {
    const userId = String(socket.data.userId);
    const call = data?.callId
      ? pendingCalls.get(data.callId)
      : Array.from(pendingCalls.values()).find((pendingCall) => pendingCall.calleeId === userId && !pendingCall.accepted);
    if (!call || call.calleeId !== userId) return;
    socket.emit("incomingVideoCall", {
      callId: call.callId,
      conversationId: call.conversationId,
      caller: call.caller,
      callType: call.callType,
      accepted: call.accepted,
    });
    if (call.accepted) {
      socket.emit("callAccepted", {
        callId: call.callId,
        conversationId: call.conversationId,
        isInitiator: false,
        callType: call.callType,
      });
      if (data?.replaySignals) {
        for (const signal of call.signalBacklog) {
          if (signal.toUserId !== userId) continue;
          socket.emit("webrtcSignal", {
            callId: call.callId,
            signalId: signal.signalId,
            type: signal.type,
            payload: signal.payload,
          });
        }
      }
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
      void sendPushToUsers(
        [call.calleeId],
        "Call ended",
        "Call declined",
        { type: "call_ended", callId: call.callId, reason: "declined" },
        { headless: true, ttl: 45 },
      );
      pendingCalls.delete(call.callId);
      return;
    }

    call.accepted = true;
    emitToUser(io, call.callerId, "callAccepted", {
      callId: call.callId,
      conversationId: call.conversationId,
      isInitiator: true,
      callType: call.callType,
    });
    emitToUser(io, call.calleeId, "callAccepted", {
      callId: call.callId,
      conversationId: call.conversationId,
      isInitiator: false,
      callType: call.callType,
    });
  });

  socket.on("webrtcSignal", (data: {
    callId?: string;
    type?: "offer" | "answer" | "ice";
    payload?: unknown;
  }) => {
    const call = data?.callId ? pendingCalls.get(data.callId) : null;
    const userId = String(socket.data.userId);
    if (
      !call ||
      !call.accepted ||
      (call.callerId !== userId && call.calleeId !== userId) ||
      !["offer", "answer", "ice"].includes(data.type || "")
    ) return;

    const otherUserId = call.callerId === userId ? call.calleeId : call.callerId;
    const signal = {
      callId: call.callId,
      signalId: randomUUID(),
      type: data.type as "offer" | "answer" | "ice",
      payload: data.payload,
    };
    call.signalBacklog.push({
      ...signal,
      fromUserId: userId,
      toUserId: otherUserId,
    });
    if (call.signalBacklog.length > 128) {
      call.signalBacklog.splice(0, call.signalBacklog.length - 128);
    }
    emitToUser(io, otherUserId, "webrtcSignal", signal);
  });

  socket.on("endVideoCall", (data: { callId?: string }) => {
    const call = data?.callId ? pendingCalls.get(data.callId) : null;
    const userId = String(socket.data.userId);
    if (!call || (call.callerId !== userId && call.calleeId !== userId)) return;

    clearTimeout(call.timeout);
    const otherUserId = call.callerId === userId ? call.calleeId : call.callerId;
    emitToUser(io, otherUserId, "callEnded", { callId: call.callId, reason: "Call ended" });
    void sendPushToUsers(
      [otherUserId],
      "Call ended",
      "The call has ended",
      { type: "call_ended", callId: call.callId, reason: "ended" },
      { headless: true, ttl: 45 },
    );
    pendingCalls.delete(call.callId);
  });

  socket.on("disconnect", () => {
    const userId = String(socket.data.userId);
    for (const call of pendingCalls.values()) {
      if (call.callerId !== userId && call.calleeId !== userId) continue;
      if (!call.accepted && call.calleeId === userId) continue;
      if (hasConnectedClient(io, userId, socket.id)) continue;

      const disconnectedCallId = call.callId;
      setTimeout(() => {
        const currentCall = pendingCalls.get(disconnectedCallId);
        if (!currentCall || !currentCall.accepted || hasConnectedClient(io, userId)) return;
        clearTimeout(currentCall.timeout);
        const otherUserId = currentCall.callerId === userId ? currentCall.calleeId : currentCall.callerId;
        emitToUser(io, otherUserId, "callEnded", { callId: currentCall.callId, reason: "Connection lost" });
        pendingCalls.delete(currentCall.callId);
      }, 8_000);
    }
  });
}
