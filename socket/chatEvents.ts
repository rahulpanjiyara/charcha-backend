
import type { Socket, Server as SocketIoServer } from "socket.io";
import Conversation from "../modals/Conversation.js";
import Message from "../modals/Message.js";

export function registerChatEvents(socket: Socket, io: SocketIoServer) {
    socket.on('getConversations', async () => {
        //console.log('getConversations event');
        try {
            const userId = socket.data.userId;
            if (!userId) {
                socket.emit("getConversatios", {
                    success: false,
                    msg: "Unauthorised",
                });
                return;
            }
            //find all conversations where user is a participant
            const converstions = await Conversation.find({
                // participants: userId
                participants: userId,
                deletedFor: { $ne: userId },

            }

            ).sort({ updatedAt: -1 }

            ).populate({
                path: "lastMessage",
                select: "content senderId attachment createdAt"
            }).populate({
                path: "participants",
                select: "name avatar email"
            }).lean();
            socket.emit("getConversations", {
                success: true,
                data: converstions,
            })


        } catch (error) {
            console.log("getConversations error", error);
            socket.emit("getConversations", {
                success: false,
                msg: "Failed to fetch conversations."
            })
        }

    })
    socket.on("newConversation", async (data) => {
        //console.log("newConversation event: ", data);
        try {
            if (data.type === 'direct') {
                //check if already exists
                const existingConversation = await Conversation.findOne({
                    type: 'direct',
                    participants: { $all: data.participants, $size: 2 }
                }).populate({ path: "participants", select: "name avatar email" }).lean();
                // if (existingConversation) {
                //     socket.emit("newConversation", {
                //         success: true,
                //         data: { ...existingConversation, isNew: false }
                //     });
                //     return;
                // }
                if (existingConversation) {
                    // revive conversation for both users
                    const revivedConversation = await Conversation.findByIdAndUpdate(
                        existingConversation._id,
                        {
                            $pull: { deletedFor: { $in: data.participants } },
                        },
                        { new: true }
                    )
                        .populate({ path: "participants", select: "name avatar email" })
                        .lean();

                    if (!revivedConversation) return;

                    // find online participant sockets
                    const connectedSockets = Array.from(io.sockets.sockets.values())
                        .filter(s => data.participants.includes(s.data.userId));

                    // join room + emit to BOTH users
                    connectedSockets.forEach(participantSocket => {
                        participantSocket.join(revivedConversation._id.toString());

                        participantSocket.emit("newConversation", {
                            success: true,
                            data: { ...revivedConversation, isNew: true },
                        });
                    });

                    return;
                }


            }
            //create a new conversation
            const conversation = await Conversation.create({
                type: data.type,
                participants: data.participants,
                name: data.name || "", // can be empty if direct conversation
                avatar: data.avatar || "",
                createdBy: socket.data.userId,

            })
            // get all connected sockets
            const connectedSockets = Array.from(io.sockets.sockets.values())
                .filter(s => data.participants.includes(s.data.userId));

            //join this conversation by all online participants
            connectedSockets.forEach((participantSocket) => {
                participantSocket.join(conversation._id.toString());
            });

            //send conversation data back (populated)
            const populatedConversation = await Conversation.findById(conversation._id)
                .populate({
                    path: "participants",
                    select: "name avatar email"

                }).lean();

            //emit conversation to all participants
            io.to(conversation._id.toString()).emit("newConversation", {
                success: true,
                data: { ...populatedConversation, isNew: true }
            });
        } catch (error) {
            console.log("newConversation error: ", error);
            socket.emit("newConversation", {
                success: false,
                msg: "Failed to create conversation",
            })
        }
    })

    socket.on("newMessage", async (data) => {
        //console.log('newMessage event: ', data);
        try {
            const message = await Message.create({
                conversationId: data.conversationId,
                senderId: data.sender.id,
                content: data.content,
                attachment: data.attachment,
            });
            io.to(data.conversationId).emit("newMessage", {
                success: true,
                data: {
                    id: message._id,
                    content: data.content,
                    sender: {
                        id: data.sender.id,
                        name: data.sender.name,
                        avatar: data.sender.avatar,

                    },
                    attachment: data.attachment,
                    createdAt: new Date().toISOString(),
                    conversationId: data.conversationId,
                }
            });
            //update conversation's last message
            await Conversation.findByIdAndUpdate(data.conversationId, {
                lastMessage: message._id
            });

        } catch (error) {
            console.log("newMessage error", error);
            socket.emit("newMessage", {
                success: false,
                msg: "Failed to send the message"
            })
        }
    })

    socket.on("getMessages", async (data: { conversationId: string }) => {
        //console.log('getMessages event: ', data);
        try {
            const messages = await Message.find({
                conversationId: data.conversationId,

            }).sort({ createdAt: -1 })
                .populate<{ senderId: { _id: string; name: string; avatar: string } }>({
                    path: "senderId",
                    select: "name avatar",
                }).lean();
            const messageWithSender = messages.map(message => ({
                ...message, id: message._id,
                sender: {
                    id: message.senderId._id,
                    name: message.senderId.name,
                    avatar: message.senderId.avatar,

                },
            }));
            socket.emit("getMessages", {
                success: true,
                data: messageWithSender,
            })

        } catch (error) {
            console.log("getMessages error", error);
            socket.emit("getMessages", {
                success: false,
                msg: "Failed to get the messages"
            })
        }
    })

    socket.on("deleteConversation", async (data: { conversationId: string }) => {
        try {
            const userId = socket.data.userId;
            const { conversationId } = data;

            if (!userId || !conversationId) {
                socket.emit("deleteConversation", {
                    success: false,
                    msg: "Unauthorized or missing conversationId",
                });
                return;
            }

            // Make sure the user is a participant
            const conversation = await Conversation.findById(conversationId);
            if (
                !conversation ||
                !conversation.participants.some(
                    (p: any) => p.toString() === userId.toString()
                )
            ) {
                socket.emit("deleteConversation", {
                    success: false,
                    msg: "Conversation not found or not allowed",
                });
                return;
            }

            // Delete all messages of this conversation
            await Message.deleteMany({ conversationId });

            // // Delete the conversation
            // await Conversation.findByIdAndDelete(conversationId);

            await Conversation.findByIdAndUpdate(conversationId, {
                $addToSet: { deletedFor: userId },
            });


            // Notify the user that conversation was deleted
            socket.emit("deleteConversation", {
                success: true,
                data: { conversationId },
            });

            // Optionally, notify other participants
            const otherParticipants = conversation.participants.filter(
                (id: any) => id.toString() !== userId.toString()
            );
            otherParticipants.forEach((participantId: any) => {
                const participantSocket = Array.from(io.sockets.sockets.values()).find(
                    (s) => s.data.userId.toString() === participantId.toString()
                );
                //participantSocket?.emit("deleteConversation", { conversationId });
                participantSocket?.emit("deleteConversation", {
                    success: true,
                    data: { conversationId },
                });

            });
        } catch (error) {
            console.log("deleteConversation error:", error);
            socket.emit("deleteConversation", {
                success: false,
                msg: "Failed to delete conversation",
            });
        }
    });

    socket.on("deleteMessage", async (data: { conversationId: string; messageId: string }) => {
        try {
            const userId = socket.data.userId;
            const { conversationId, messageId } = data;

            if (!userId || !conversationId || !messageId) {
                socket.emit("deleteMessage", { success: false, msg: "Invalid request" });
                return;
            }

            const message = await Message.findById(messageId);

            if (!message) {
                socket.emit("deleteMessage", { success: false, msg: "Message not found" });
                return;
            }

            if (message.senderId.toString() !== userId) {
                socket.emit("deleteMessage", { success: false, msg: "Not allowed" });
                return;
            }

            await Message.findByIdAndDelete(messageId);

            // Notify all participants
            io.to(conversationId).emit("deleteMessage", { success: true, messageId });

        } catch (err) {
            console.log("deleteMessage error:", err);
            socket.emit("deleteMessage", { success: false, msg: "Failed to delete message" });
        }
    });



}