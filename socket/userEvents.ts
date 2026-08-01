import type { Socket, Server as SocketIoServer } from "socket.io";
import User from "../modals/User.js";
import { generateToken } from "../utils/token.js";
import FriendRequest from "../modals/FriendRequest.js";
import { isValidObjectId, Types } from "mongoose";
import Post from "../modals/Post.js";
import Conversation from "../modals/Conversation.js";
import Message from "../modals/Message.js";

const publicUser = (user: any) => ({
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    avatar: user.avatar || "",
    about: user.about || "",
    status: user.status || "Available",
    mobile: user.mobile || "",
});

const notifyFriendDataChanged = (io: SocketIoServer, userIds: string[]) => {
    for (const client of io.sockets.sockets.values()) {
        if (userIds.includes(String(client.data.userId))) {
            client.emit("friendDataChanged", { success: true });
        }
    }
};

async function friendIdsFor(userId: string) {
    const relationships = await FriendRequest.find({
        status: "accepted",
        $or: [{ sender: userId }, { recipient: userId }],
    }).lean();
    return relationships.map((request) =>
        request.sender.toString() === userId
            ? request.recipient.toString()
            : request.sender.toString()
    );
}

export function registerUserEvents(socket: Socket, io: SocketIoServer) {
  
    socket.on("updateProfile", async (data: { name?: string; avatar?: string; about?: string; status?: string; mobile?: string }) => {
        //console.log('updateprofile event', data);

        const userId = socket.data.userId;
        if (!userId) {
            return socket.emit('updateProfile', {
                success: false, message: "Unauthorised"
            })

        }
        try {
            const name = String(data?.name || "").trim();
            const avatar = typeof data?.avatar === "string" ? data.avatar : "";
            const about = String(data?.about || "").trim().slice(0, 300);
            const profileStatus = String(data?.status || "Available").trim().slice(0, 80) || "Available";
            const mobile = String(data?.mobile || "").trim().slice(0, 24);
            if (!name) {
                return socket.emit("updateProfile", {
                    success: false,
                    msg: "Name is required",
                });
            }
            const updatedUser = await User.findByIdAndUpdate(
                userId,
                { name, avatar, about, status: profileStatus, mobile },
                { new: true, runValidators: true }
            )
            if (!updatedUser) {
                return socket.emit('updateProfile', {
                    success: false,
                    msg: "User not found"
                })
            }
            //get token with updated value
            const newToken = generateToken(updatedUser);
            socket.emit('updateProfile', {
                success: true,
                data: { token: newToken },
                msg: "Profile updated successfully"
            })
        } catch (error) {
            console.log('Error updating profile: ', error)
            socket.emit('updateProfile', {
                success: false, msg: "Error updating profile"
            })
        }
    })

    socket.on("getUserProfile", async (data: { userId?: string }) => {
        try {
            const requestedId = String(data?.userId || socket.data.userId || "");
            if (!isValidObjectId(requestedId)) {
                return socket.emit("getUserProfile", { success: false, msg: "Invalid user" });
            }
            const profile = await User.findById(requestedId).select("name email avatar about status mobile created").lean();
            if (!profile) return socket.emit("getUserProfile", { success: false, msg: "User not found" });
            socket.emit("getUserProfile", {
                success: true,
                data: { ...publicUser(profile), joinedAt: profile.created },
            });
        } catch (error) {
            console.error("getUserProfile error", error);
            socket.emit("getUserProfile", { success: false, msg: "Could not load profile" });
        }
    });

    socket.on("getUserPosts", async (data: { userId?: string }) => {
        try {
            const viewerId = String(socket.data.userId || "");
            const requestedId = String(data?.userId || viewerId);
            if (!isValidObjectId(requestedId)) {
                return socket.emit("getUserPosts", { success: false, msg: "Invalid user" });
            }
            const allowedIds = new Set([viewerId, ...(await friendIdsFor(viewerId))]);
            if (!allowedIds.has(requestedId)) {
                return socket.emit("getUserPosts", { success: false, msg: "Only friends can view this feed" });
            }
            const posts = await Post.find({ author: requestedId })
                .sort({ createdAt: -1 })
                .limit(50)
                .populate("author", "name avatar about status mobile")
                .lean();
            socket.emit("getUserPosts", {
                success: true,
                data: posts.map((post: any) => ({
                    id: post._id.toString(),
                    author: publicUser(post.author),
                    content: post.content,
                    image: post.image,
                    likesCount: post.likes?.length || 0,
                    likedByMe: post.likes?.some((id: any) => id.toString() === viewerId) || false,
                    commentsCount: post.comments?.length || 0,
                    createdAt: post.createdAt,
                })),
            });
        } catch (error) {
            console.error("getUserPosts error", error);
            socket.emit("getUserPosts", { success: false, msg: "Could not load this feed" });
        }
    });

    socket.on("getContacts", async()=>{
        try {
            const currentUserId = socket.data.userId;
            if(!currentUserId){
                socket.emit("getContacts",{
                    success:false,
                    msg:"Unauthorised",
                });
                return;
            }
            const accepted = await FriendRequest.find({
                status: "accepted",
                $or: [{ sender: currentUserId }, { recipient: currentUserId }],
            }).lean();
            const friendIds = accepted.map((request) =>
                request.sender.toString() === String(currentUserId)
                    ? request.recipient
                    : request.sender
            );
            const users = await User.find({_id:{$in:friendIds}},{password:0}).lean();
            const contacts = users.map((user)=>({
                    id:user._id.toString(),
                    name:user.name,
                    email:user.email,
                    avatar:user.avatar || "",
            }));
            socket.emit("getContacts",{
                success:true,
                data:contacts,
               
            })
        } catch (error:any) {
            console.log("getContacts error: ",error);
            socket.emit("getContacts",{
                success:false,
                msg:"Failed to fetch contacts",
            })
        }
    })

    socket.on("getFriendData", async () => {
        try {
            const userId = String(socket.data.userId);
            const [relationships, users, directConversations] = await Promise.all([
                FriendRequest.find({
                    $or: [{ sender: userId }, { recipient: userId }],
                    status: { $in: ["pending", "accepted"] },
                }).lean(),
                User.find({ _id: { $ne: userId } }, { password: 0 }).lean(),
                Conversation.find({ type: "direct", participants: userId, deletedFor: { $ne: userId } })
                    .select("_id participants")
                    .lean(),
            ]);

            const directConversationIds = directConversations.map((conversation) => conversation._id);
            const unreadGroups = directConversationIds.length ? await Message.aggregate([
                {
                    $match: {
                        conversationId: { $in: directConversationIds },
                        senderId: { $ne: new Types.ObjectId(userId) },
                        readBy: { $exists: true, $ne: new Types.ObjectId(userId) },
                    },
                },
                { $group: { _id: "$conversationId", count: { $sum: 1 } } },
            ]) : [];
            const unreadByConversation = new Map(unreadGroups.map((item) => [item._id.toString(), item.count]));
            const unreadByFriend = new Map<string, number>();
            for (const conversation of directConversations) {
                const otherId = conversation.participants.find((id) => id.toString() !== userId)?.toString();
                if (otherId) unreadByFriend.set(otherId, unreadByConversation.get(conversation._id.toString()) || 0);
            }

            const usersById = new Map(users.map((user) => [user._id.toString(), user]));
            const onlineIds = new Set(
                Array.from(io.sockets.sockets.values())
                    .filter((client) => client.connected)
                    .map((client) => String(client.data.userId))
            );
            const relatedIds = new Set<string>();
            const friends: any[] = [];
            const incoming: any[] = [];
            const outgoing: any[] = [];

            for (const relationship of relationships) {
                const senderId = relationship.sender.toString();
                const recipientId = relationship.recipient.toString();
                const otherId = senderId === userId ? recipientId : senderId;
                const other = usersById.get(otherId);
                if (!other) continue;
                relatedIds.add(otherId);
                const item = { requestId: relationship._id.toString(), user: { ...publicUser(other), online: onlineIds.has(otherId) }, unreadCount: unreadByFriend.get(otherId) || 0 };
                if (relationship.status === "accepted") friends.push(item);
                else if (recipientId === userId) incoming.push(item);
                else outgoing.push(item);
            }

            const suggestions = users
                .filter((user) => !relatedIds.has(user._id.toString()))
                .map((user) => ({ ...publicUser(user), online: onlineIds.has(user._id.toString()) }));

            socket.emit("getFriendData", {
                success: true,
                data: { friends, incoming, outgoing, suggestions },
            });
        } catch (error) {
            console.error("getFriendData error", error);
            socket.emit("getFriendData", { success: false, msg: "Failed to load people" });
        }
    });

    socket.on("sendFriendRequest", async (data: { userId?: string }) => {
        try {
            const senderId = String(socket.data.userId);
            const recipientId = String(data?.userId || "");
            if (!isValidObjectId(recipientId) || recipientId === senderId) {
                return socket.emit("sendFriendRequest", { success: false, msg: "Invalid user" });
            }
            const recipientExists = await User.exists({ _id: recipientId });
            if (!recipientExists) return socket.emit("sendFriendRequest", { success: false, msg: "User not found" });

            const existing = await FriendRequest.findOne({
                $or: [
                    { sender: senderId, recipient: recipientId },
                    { sender: recipientId, recipient: senderId },
                ],
                status: { $in: ["pending", "accepted"] },
            });
            if (existing) {
                return socket.emit("sendFriendRequest", {
                    success: false,
                    msg: existing.status === "accepted" ? "You are already friends" : "A request is already pending",
                });
            }

            await FriendRequest.findOneAndUpdate(
                { sender: senderId, recipient: recipientId },
                { status: "pending" },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            socket.emit("sendFriendRequest", { success: true, msg: "Friend request sent" });
            notifyFriendDataChanged(io, [senderId, recipientId]);
        } catch (error) {
            console.error("sendFriendRequest error", error);
            socket.emit("sendFriendRequest", { success: false, msg: "Could not send request" });
        }
    });

    socket.on("respondFriendRequest", async (data: { requestId?: string; action?: string }) => {
        try {
            const userId = String(socket.data.userId);
            if (!data?.requestId || !isValidObjectId(data.requestId) || !["accept", "reject"].includes(String(data.action))) {
                return socket.emit("respondFriendRequest", { success: false, msg: "Invalid request" });
            }
            const request = await FriendRequest.findOneAndUpdate(
                { _id: data.requestId, recipient: userId, status: "pending" },
                { status: data.action === "accept" ? "accepted" : "rejected" },
                { new: true }
            );
            if (!request) return socket.emit("respondFriendRequest", { success: false, msg: "Request is no longer available" });
            socket.emit("respondFriendRequest", { success: true, msg: data.action === "accept" ? "Friend added" : "Request declined" });
            notifyFriendDataChanged(io, [request.sender.toString(), request.recipient.toString()]);
        } catch (error) {
            console.error("respondFriendRequest error", error);
            socket.emit("respondFriendRequest", { success: false, msg: "Could not update request" });
        }
    });

    socket.on("getFeed", async () => {
        try {
            const userId = String(socket.data.userId);
            const friendIds = await friendIdsFor(userId);
            const posts = await Post.find({ author: { $in: [userId, ...friendIds] } })
                .sort({ createdAt: -1 })
                .limit(50)
                .populate("author", "name avatar")
                .populate("comments.author", "name avatar")
                .lean();
            socket.emit("getFeed", {
                success: true,
                data: posts.map((post: any) => ({
                    id: post._id.toString(),
                    author: publicUser(post.author),
                    content: post.content,
                    image: post.image,
                    isMine: post.author._id.toString() === userId,
                    likesCount: post.likes?.length || 0,
                    likedByMe: post.likes?.some((id: any) => id.toString() === userId) || false,
                    comments: (post.comments || []).map((comment: any) => ({
                        id: comment._id.toString(),
                        author: publicUser(comment.author),
                        content: comment.content,
                        createdAt: comment.createdAt,
                    })),
                    createdAt: post.createdAt,
                })),
            });
        } catch (error) {
            console.error("getFeed error", error);
            socket.emit("getFeed", { success: false, msg: "Could not load feed" });
        }
    });

    socket.on("createPost", async (data: { content?: string; image?: string }) => {
        try {
            const userId = String(socket.data.userId);
            const content = String(data?.content || "").trim();
            const image = typeof data?.image === "string" ? data.image : "";
            if (!content && !image) return socket.emit("createPost", { success: false, msg: "Write something or add a photo" });
            await Post.create({ author: userId, content, image });
            socket.emit("createPost", { success: true, msg: "Posted" });
            const friendIds = await friendIdsFor(userId);
            for (const client of io.sockets.sockets.values()) {
                if ([userId, ...friendIds].includes(String(client.data.userId))) client.emit("feedChanged", { success: true });
            }
        } catch (error) {
            console.error("createPost error", error);
            socket.emit("createPost", { success: false, msg: "Could not create post" });
        }
    });

    socket.on("deletePost", async (data: { postId?: string }) => {
        try {
            const userId = String(socket.data.userId);
            if (!data?.postId || !isValidObjectId(data.postId)) {
                return socket.emit("deletePost", { success: false, msg: "Invalid post" });
            }
            const post = await Post.findOneAndDelete({ _id: data.postId, author: userId });
            if (!post) return socket.emit("deletePost", { success: false, msg: "Post not found or not allowed" });
            socket.emit("deletePost", { success: true, data: { postId: data.postId } });
            const viewers = [userId, ...(await friendIdsFor(userId))];
            for (const client of io.sockets.sockets.values()) {
                if (viewers.includes(String(client.data.userId))) client.emit("feedChanged", { success: true });
            }
        } catch (error) {
            console.error("deletePost error", error);
            socket.emit("deletePost", { success: false, msg: "Could not delete post" });
        }
    });

    socket.on("togglePostLike", async (data: { postId?: string }) => {
        try {
            const userId = String(socket.data.userId);
            if (!data?.postId || !isValidObjectId(data.postId)) return;
            const post = await Post.findById(data.postId);
            if (!post) return;
            const hasLiked = post.likes.some((id: any) => id.toString() === userId);
            await Post.findByIdAndUpdate(post._id, hasLiked ? { $pull: { likes: userId } } : { $addToSet: { likes: userId } });
            socket.emit("togglePostLike", { success: true });
            const authorId = post.author.toString();
            for (const client of io.sockets.sockets.values()) {
                if ([userId, authorId].includes(String(client.data.userId))) client.emit("feedChanged", { success: true });
            }
        } catch (error) {
            console.error("togglePostLike error", error);
        }
    });

    socket.on("addPostComment", async (data: { postId?: string; content?: string }) => {
        try {
            const userId = String(socket.data.userId);
            const content = String(data?.content || "").trim();
            if (!data?.postId || !isValidObjectId(data.postId) || !content || content.length > 500) {
                return socket.emit("addPostComment", { success: false, msg: "Enter a comment up to 500 characters" });
            }
            const post = await Post.findById(data.postId).select("author");
            if (!post) return socket.emit("addPostComment", { success: false, msg: "Post not found" });

            const authorId = post.author.toString();
            const allowedViewerIds = authorId === userId ? [] : await friendIdsFor(userId);
            if (authorId !== userId && !allowedViewerIds.includes(authorId)) {
                return socket.emit("addPostComment", { success: false, msg: "Only friends can comment on this post" });
            }

            await Post.findByIdAndUpdate(post._id, {
                $push: {
                    comments: {
                        $each: [{ author: userId, content, createdAt: new Date() }],
                        $slice: -100,
                    },
                },
            });
            socket.emit("addPostComment", { success: true, data: { postId: post._id.toString() } });

            const viewers = [authorId, ...(await friendIdsFor(authorId))];
            for (const client of io.sockets.sockets.values()) {
                if (viewers.includes(String(client.data.userId))) client.emit("feedChanged", { success: true });
            }
        } catch (error) {
            console.error("addPostComment error", error);
            socket.emit("addPostComment", { success: false, msg: "Could not add comment" });
        }
    });

    // Example event: join a room
    socket.on('joinRoom', (roomId: string) => {
        socket.join(roomId);
        console.log(`User ${socket.data.userId} joined room ${roomId}`);
        socket.to(roomId).emit('userJoined', { userId: socket.data.userId, name: socket.data.name });
    });

    // Example event: leave a room
    socket.on('leaveRoom', (roomId: string) => {
        socket.leave(roomId);
        console.log(`User ${socket.data.userId} left room ${roomId}`);
        socket.to(roomId).emit('userLeft', { userId: socket.data.userId, name: socket.data.name });
    });

    // Example event: send message to a room
    socket.on('sendMessage', ({ roomId, message }: { roomId: string; message: string }) => {
        console.log(`User ${socket.data.userId} sent message to room ${roomId}: ${message}`);
        io.to(roomId).emit('newMessage', { userId: socket.data.userId, name: socket.data.name, message });
    });
}
