import dotenv from "dotenv";
dotenv.config();

import { Server as SocketIoServer, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import Conversation from "../modals/Conversation.js";
import { registerUserEvents } from "./userEvents.js";
import { registerChatEvents } from "./chatEvents.js";
import { registerCallEvents } from "./callEvents.js";

export function initializeSocket(server: any): SocketIoServer {
  const io = new SocketIoServer(server, {
    cors: {
      origin: "*",
    },
    transports: ["websocket", "polling"], // important for Expo/iOS
  });

  /* =======================
     SOCKET AUTH MIDDLEWARE
     ======================= */
  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error("Authentication error: Token missing"));
    }

    jwt.verify(
      token,
      process.env.JWT_SECRET as string,
      (err: any, decoded: any) => {
        if (err) {
          return next(new Error("Authentication error: Invalid token"));
        }

        // Attach user data to socket
        socket.data.user = decoded.user;
        socket.data.userId = decoded.user.id;

        next();
      }
    );
  });

  /* =======================
     SOCKET CONNECTION
     ======================= */
  io.on("connection", async (socket: Socket) => {
    const userId = socket.data.userId;

    console.log(`🟢 User connected: ${userId}`);

    // Register handlers before awaiting any database work. Clients may emit
    // immediately after the Socket.IO `connect` event, so delaying this would
    // drop their first getConversations/getMessages request.
    registerUserEvents(socket, io);
    registerChatEvents(socket, io);
    registerCallEvents(socket, io);
    io.emit("presenceChanged", { userId: String(userId), online: true });

    /* =======================
       JOIN ACTIVE CONVERSATIONS
       ======================= */
    try {
      const conversations = await Conversation.find({
        participants: userId,
        deletedFor: { $ne: userId }, // VERY IMPORTANT
      }).select("_id");

      conversations.forEach((conversation) => {
        socket.join(conversation._id.toString());
      });

      console.log(
        `📥 User ${userId} joined ${conversations.length} conversations`
      );
    } catch (error) {
      console.error("❌ Error joining conversations:", error);
    }

    /* =======================
       DISCONNECT
       ======================= */
    socket.on("disconnect", () => {
      console.log(`🔴 User disconnected: ${userId}`);
      const hasAnotherConnection = Array.from(io.sockets.sockets.values()).some(
        (client) => client.id !== socket.id && client.connected && String(client.data.userId) === String(userId)
      );
      if (!hasAnotherConnection) {
        io.emit("presenceChanged", { userId: String(userId), online: false });
      }
    });
  });

  return io;
}
