import { isValidObjectId, Types } from "mongoose";
import type { Server as SocketIoServer, Socket } from "socket.io";
import Conversation from "../modals/Conversation.js";
import Message from "../modals/Message.js";
import User from "../modals/User.js";
import FriendRequest from "../modals/FriendRequest.js";
import { createActivities } from "../utils/notifications.js";

const disappearingDurations = new Set([0, 3600, 86400, 604800, 2592000]);
const visibleMessageFilter = () => ({
  $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
});

function clearedAtFor(conversation: any, userId: string): Date | null {
  const stored = conversation?.clearedAtBy instanceof Map
    ? conversation.clearedAtBy.get(userId)
    : conversation?.clearedAtBy?.[userId];
  if (!stored) return null;
  const value = new Date(stored);
  return Number.isNaN(value.getTime()) ? null : value;
}

function visibleToUserFilter(conversation: any, userId: string) {
  const clearedAt = clearedAtFor(conversation, userId);
  return {
    ...visibleMessageFilter(),
    ...(clearedAt ? { createdAt: { $gt: clearedAt } } : {}),
  };
}

const fail = (socket: Socket, event: string, msg: string) =>
  socket.emit(event, { success: false, msg });

async function memberConversation(conversationId: unknown, userId: string) {
  if (typeof conversationId !== "string" || !isValidObjectId(conversationId)) {
    return null;
  }
  return Conversation.findOne({ _id: conversationId, participants: userId });
}

async function unreadCountFor(userId: string) {
  const conversations = await Conversation.find({
    participants: userId,
    deletedFor: { $ne: userId },
  }).select("_id clearedAtBy").lean();
  const counts = await Promise.all(conversations.map((conversation) =>
    Message.countDocuments({
      conversationId: conversation._id,
      senderId: { $ne: userId },
      readBy: { $exists: true, $ne: userId },
      ...visibleToUserFilter(conversation, userId),
    })
  ));
  return counts.reduce((total, count) => total + count, 0);
}

function notifyUnreadChanged(io: SocketIoServer, userIds: string[]) {
  for (const client of io.sockets.sockets.values()) {
    if (userIds.includes(String(client.data.userId))) {
      client.emit("unreadChanged", { success: true });
    }
  }
}

export function registerChatEvents(socket: Socket, io: SocketIoServer) {
  socket.on("getConversationPresence", async (data: { conversationId?: string; userId?: string }) => {
    try {
      const currentUserId = String(socket.data.userId);
      const targetUserId = String(data?.userId || "");
      const conversation = await memberConversation(data?.conversationId, currentUserId);
      if (!conversation || !isValidObjectId(targetUserId)) {
        return fail(socket, "getConversationPresence", "Invalid conversation or user");
      }

      const isParticipant = conversation.participants.some(
        (participantId: any) => String(participantId) === targetUserId
      );
      if (!isParticipant || targetUserId === currentUserId) {
        return fail(socket, "getConversationPresence", "User is not part of this conversation");
      }

      const online = Array.from(io.sockets.sockets.values()).some(
        (client) => client.connected && String(client.data.userId) === targetUserId
      );
      socket.emit("getConversationPresence", {
        success: true,
        data: { userId: targetUserId, online },
      });
    } catch (error) {
      console.error("getConversationPresence error", error);
      fail(socket, "getConversationPresence", "Could not load presence");
    }
  });

  socket.on("typing", (data: { conversationId?: string; isTyping?: boolean }) => {
    const conversationId = data?.conversationId;
    if (
      typeof conversationId !== "string" ||
      !isValidObjectId(conversationId) ||
      !socket.rooms.has(conversationId)
    ) return;

    socket.to(conversationId).emit("typing", {
      conversationId,
      userId: String(socket.data.userId),
      name: socket.data.user?.name || "Someone",
      isTyping: Boolean(data.isTyping),
    });
  });

  socket.on("getConversations", async () => {
    try {
      const userId = socket.data.userId;
      const conversations = await Conversation.find({
        participants: userId,
        deletedFor: { $ne: userId },
      })
        .sort({ updatedAt: -1 })
        .populate("lastMessage", "content senderId attachment createdAt")
        .populate("participants", "name avatar email")
        .lean();

      const onlineIds = new Set(
        Array.from(io.sockets.sockets.values())
          .filter((client) => client.connected)
          .map((client) => String(client.data.userId))
      );

      const data = await Promise.all(conversations.map(async (conversation: any) => {
        const clearedAt = clearedAtFor(conversation, String(userId));
        const lastMessage = conversation.lastMessage as any;
        const lastMessageVisible = !clearedAt || !lastMessage?.createdAt ||
          new Date(lastMessage.createdAt).getTime() > clearedAt.getTime();
        return {
          ...conversation,
          participants: conversation.participants.map((participant: any) => ({
            ...participant,
            online: onlineIds.has(String(participant._id)),
          })),
          lastMessage: lastMessageVisible ? lastMessage : null,
          unreadCount: await Message.countDocuments({
          conversationId: conversation._id,
          senderId: { $ne: userId },
          readBy: { $exists: true, $ne: userId },
          ...visibleToUserFilter(conversation, String(userId)),
        }),
        };
      }));
      socket.emit("getConversations", { success: true, data });
    } catch (error) {
      console.error("getConversations error", error);
      fail(socket, "getConversations", "Failed to fetch conversations");
    }
  });

  socket.on("getUnreadCount", async () => {
    try {
      const userId = String(socket.data.userId);
      socket.emit("getUnreadCount", { success: true, data: { count: await unreadCountFor(userId) } });
    } catch (error) {
      console.error("getUnreadCount error", error);
      fail(socket, "getUnreadCount", "Could not load unread messages");
    }
  });

  socket.on("newConversation", async (data: any) => {
    try {
      const userId = String(socket.data.userId);
      const type = data?.type;
      const participantIds: string[] = Array.isArray(data?.participants)
        ? [...new Set<string>(data.participants.map((id: unknown) => String(id)))]
        : [];

      if (!participantIds.includes(userId)) participantIds.push(userId);
      if (
        !["direct", "group"].includes(type) ||
        participantIds.some((id) => !isValidObjectId(id)) ||
        (type === "direct" && participantIds.length !== 2) ||
        (type === "group" && (participantIds.length < 3 || !String(data?.name || "").trim()))
      ) {
        return fail(socket, "newConversation", "Invalid conversation data");
      }

      const validUserCount = await User.countDocuments({ _id: { $in: participantIds } });
      if (validUserCount !== participantIds.length) {
        return fail(socket, "newConversation", "One or more participants do not exist");
      }

      const otherParticipantIds = participantIds.filter((id) => id !== userId);
      const friendCount = await FriendRequest.countDocuments({
        status: "accepted",
        $or: otherParticipantIds.flatMap((otherId) => [
          { sender: userId, recipient: otherId },
          { sender: otherId, recipient: userId },
        ]),
      });
      if (friendCount !== otherParticipantIds.length) {
        return fail(socket, "newConversation", "You can only message accepted friends");
      }

      if (type === "direct") {
        const existing = await Conversation.findOne({
          type: "direct",
          participants: { $all: participantIds, $size: 2 },
        });
        if (existing) {
          existing.deletedFor = existing.deletedFor.filter(
            (id) => id.toString() !== userId
          );
          await existing.save();
          const revived = await Conversation.findById(existing._id)
            .populate("lastMessage", "content senderId attachment createdAt")
            .populate("participants", "name avatar email")
            .lean();
          if (revived) {
            const clearedAt = clearedAtFor(revived, userId);
            const lastMessage = revived.lastMessage as any;
            if (clearedAt && lastMessage?.createdAt &&
              new Date(lastMessage.createdAt).getTime() <= clearedAt.getTime()) {
              revived.lastMessage = undefined;
            }
          }
          socket.join(existing._id.toString());
          socket.emit("newConversation", { success: true, data: revived });
          return;
        }
      }

      const conversation = new Conversation({
        type,
        participants: participantIds.map((id) => new Types.ObjectId(id)),
        name: type === "group" ? String(data.name).trim() : "",
        avatar: type === "group" && typeof data.avatar === "string" ? data.avatar : "",
        createdBy: new Types.ObjectId(userId),
      });
      await conversation.save();
      const populated = await Conversation.findById(conversation._id)
        .populate("participants", "name avatar email")
        .lean();

      for (const client of io.sockets.sockets.values()) {
        if (participantIds.includes(String(client.data.userId))) {
          client.join(conversation._id.toString());
          client.emit("newConversation", { success: true, data: populated });
        }
      }
    } catch (error) {
      console.error("newConversation error", error);
      fail(socket, "newConversation", "Failed to create conversation");
    }
  });

  socket.on("newMessage", async (data: any) => {
    try {
      const userId = String(socket.data.userId);
      const conversation = await memberConversation(data?.conversationId, userId);
      const content = typeof data?.content === "string" ? data.content.trim() : "";
      const attachment = typeof data?.attachment === "string" ? data.attachment : "";
      const messageType: "text" | "image" | "voice" = ["text", "image", "voice"].includes(String(data?.messageType))
        ? data.messageType as "text" | "image" | "voice"
        : attachment ? "image" : "text";
      const audioDuration = messageType === "voice" ? Math.min(600, Math.max(0, Number(data?.audioDuration) || 0)) : 0;
      if (!conversation || (!content && !attachment)) {
        return fail(socket, "newMessage", "Conversation not found or message is empty");
      }

      if (conversation.type === "direct") {
        const otherUserId = conversation.participants.find((id) => id.toString() !== userId)?.toString();
        const friendship = otherUserId && await FriendRequest.exists({
          status: "accepted",
          $or: [
            { sender: userId, recipient: otherUserId },
            { sender: otherUserId, recipient: userId },
          ],
        });
        if (!friendship) return fail(socket, "newMessage", "Only accepted friends can message each other");
      }

      const sender = await User.findById(userId).select("name avatar").lean();
      if (!sender) return fail(socket, "newMessage", "Sender not found");

      const message: any = await Message.create({
        conversationId: conversation._id,
        senderId: userId,
        content,
        attachment,
        messageType,
        audioDuration,
        readBy: [new Types.ObjectId(userId)],
        expiresAt: conversation.disappearingMessagesSeconds
          ? new Date(Date.now() + conversation.disappearingMessagesSeconds * 1000)
          : null,
      });
      conversation.lastMessage = message._id;
      conversation.deletedFor = [];
      await conversation.save();

      io.to(conversation._id.toString()).emit("newMessage", {
        success: true,
        data: {
          id: message._id.toString(),
          content,
          sender: { id: userId, name: sender.name, avatar: sender.avatar },
          attachment,
          messageType,
          audioDuration,
          createdAt: message.createdAt,
          expiresAt: message.expiresAt,
          conversationId: conversation._id.toString(),
        },
      });
      const recipientIds = conversation.participants
        .map((id) => id.toString())
        .filter((id) => id !== userId);
      const pushRecipientIds = recipientIds.filter((recipientId) => {
        const viewingThisChat = Array.from(io.sockets.sockets.values()).some(
          (client) => client.connected
            && String(client.data.userId) === recipientId
            && client.data.notificationAppState === "active"
            && String(client.data.activeConversationId || "") === conversation._id.toString()
        );
        return !viewingThisChat;
      });
      for (const client of io.sockets.sockets.values()) {
        if (recipientIds.includes(String(client.data.userId))) {
          client.emit("messageNotification", {
            success: true,
            data: {
              conversationId: conversation._id.toString(),
              type: conversation.type,
              conversationName: conversation.name || "",
              conversationAvatar: conversation.avatar || "",
              sender: { id: userId, name: sender.name, avatar: sender.avatar || "" },
              content: messageType === "voice" ? "Sent a voice message" : attachment && !content ? "Sent a photo" : content,
              createdAt: message.createdAt,
            },
          });
        }
      }
      notifyUnreadChanged(io, recipientIds);
      const notificationParams = new URLSearchParams({
        id: conversation._id.toString(),
        type: conversation.type,
        name: conversation.type === "group" ? conversation.name || "Group" : sender.name || "Friend",
        avatar: conversation.type === "group" ? conversation.avatar || "" : sender.avatar || "",
        participants: "[]",
        targetName: sender.name || "Friend",
        targetAvatar: sender.avatar || "",
        targetId: userId,
      });
      void createActivities({
        recipientIds,
        pushRecipientIds,
        actorId: userId,
        type: "message",
        title: conversation.type === "group" ? conversation.name || "New group message" : sender.name || "New message",
        body: messageType === "voice" ? "Sent a voice message" : attachment && !content ? "Sent a photo" : content.slice(0, 180),
        data: {
          url: `/(main)/conversation?${notificationParams.toString()}`,
          conversationId: conversation._id.toString(),
        },
      });
    } catch (error) {
      console.error("newMessage error", error);
      fail(socket, "newMessage", "Failed to send the message");
    }
  });

  socket.on("getMessages", async (data: { conversationId?: string }) => {
    try {
      const userId = String(socket.data.userId);
      const conversation = await memberConversation(data?.conversationId, userId);
      if (!conversation) return fail(socket, "getMessages", "Conversation not found");

      await Message.updateMany(
        {
          conversationId: conversation._id,
          senderId: { $ne: userId },
          readBy: { $ne: userId },
          ...visibleToUserFilter(conversation, userId),
        },
        { $addToSet: { readBy: userId } }
      );
      notifyUnreadChanged(io, [userId]);

      const messages = await Message.find({
        conversationId: conversation._id,
        ...visibleToUserFilter(conversation, userId),
      })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate<{ senderId: { _id: string; name: string; avatar: string } }>(
          "senderId",
          "name avatar"
        )
        .lean();
      const dataWithSender = messages.map((message) => ({
        ...message,
        id: message._id.toString(),
        sender: {
          id: message.senderId._id.toString(),
          name: message.senderId.name,
          avatar: message.senderId.avatar,
        },
      }));
      socket.emit("getMessages", { success: true, data: dataWithSender });
    } catch (error) {
      console.error("getMessages error", error);
      fail(socket, "getMessages", "Failed to get the messages");
    }
  });

  socket.on("getConversationSettings", async (data: { conversationId?: string }) => {
    try {
      const userId = String(socket.data.userId);
      const conversation = await memberConversation(data?.conversationId, userId);
      if (!conversation) return fail(socket, "getConversationSettings", "Conversation not found");

      socket.emit("getConversationSettings", {
        success: true,
        data: {
          conversationId: conversation._id.toString(),
          disappearingMessagesSeconds: conversation.disappearingMessagesSeconds || 0,
          type: conversation.type,
          createdBy: conversation.createdBy?.toString() || null,
        },
      });
    } catch (error) {
      console.error("getConversationSettings error", error);
      fail(socket, "getConversationSettings", "Could not load conversation settings");
    }
  });

  socket.on("setDisappearingMessages", async (data: { conversationId?: string; seconds?: number }) => {
    try {
      const userId = String(socket.data.userId);
      const conversation = await memberConversation(data?.conversationId, userId);
      const seconds = Number(data?.seconds);
      if (!conversation || !disappearingDurations.has(seconds)) {
        return fail(socket, "disappearingMessagesChanged", "Invalid disappearing-message setting");
      }

      conversation.disappearingMessagesSeconds = seconds;
      await conversation.save();
      io.to(conversation._id.toString()).emit("disappearingMessagesChanged", {
        success: true,
        data: {
          conversationId: conversation._id.toString(),
          disappearingMessagesSeconds: seconds,
          updatedBy: userId,
        },
      });
    } catch (error) {
      console.error("setDisappearingMessages error", error);
      fail(socket, "disappearingMessagesChanged", "Could not update disappearing messages");
    }
  });

  socket.on("deleteConversation", async (data: { conversationId?: string; mode?: "me" | "everyone" }) => {
    try {
      const userId = String(socket.data.userId);
      const conversation = await memberConversation(data?.conversationId, userId);
      if (!conversation) return fail(socket, "deleteConversation", "Conversation not found");

      if (data.mode === "everyone") {
        if (conversation.type === "group" && conversation.createdBy?.toString() !== userId) {
          return fail(socket, "deleteConversation", "Only the group creator can delete this group");
        }
        const conversationId = conversation._id.toString();
        await Message.deleteMany({ conversationId: conversation._id });
        await conversation.deleteOne();
        io.to(conversationId).emit("deleteConversation", {
          success: true,
          data: { conversationId, mode: "everyone" },
        });
        notifyUnreadChanged(
          io,
          conversation.participants.map((participantId) => participantId.toString())
        );
        return;
      }

      await Conversation.findByIdAndUpdate(conversation._id, {
        $addToSet: { deletedFor: userId },
        $set: { [`clearedAtBy.${userId}`]: new Date() },
      });
      socket.emit("deleteConversation", {
        success: true,
        data: { conversationId: conversation._id.toString(), mode: "me" },
      });
    } catch (error) {
      console.error("deleteConversation error", error);
      fail(socket, "deleteConversation", "Failed to delete conversation");
    }
  });

  socket.on("deleteMessage", async (data: { conversationId?: string; messageId?: string }) => {
    try {
      const userId = String(socket.data.userId);
      const conversation = await memberConversation(data?.conversationId, userId);
      if (!conversation || !data?.messageId || !isValidObjectId(data.messageId)) {
        return fail(socket, "deleteMessage", "Invalid request");
      }
      const message = await Message.findOne({
        _id: data.messageId,
        conversationId: conversation._id,
        senderId: userId,
      });
      if (!message) return fail(socket, "deleteMessage", "Message not found or not allowed");

      await message.deleteOne();
      const latest = await Message.findOne({ conversationId: conversation._id })
        .sort({ createdAt: -1 })
        .select("_id");
      conversation.lastMessage = latest?._id;
      await conversation.save();
      io.to(conversation._id.toString()).emit("deleteMessage", {
        success: true,
        data: { messageId: data.messageId, conversationId: conversation._id.toString() },
      });
    } catch (error) {
      console.error("deleteMessage error", error);
      fail(socket, "deleteMessage", "Failed to delete message");
    }
  });
}
