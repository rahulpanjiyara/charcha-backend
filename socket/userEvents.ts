import type { Socket, Server as SocketIoServer } from "socket.io";
import User from "../modals/User.js";
import { generateToken } from "../utils/token.js";
import FriendRequest from "../modals/FriendRequest.js";
import { isValidObjectId, Types } from "mongoose";
import Post from "../modals/Post.js";
import Conversation from "../modals/Conversation.js";
import Message from "../modals/Message.js";
import Activity from "../modals/Activity.js";
import Moment from "../modals/Moment.js";
import { createActivities } from "../utils/notifications.js";

const publicUser = (user: any) => ({
    id: user._id.toString(),
    name: user.name,
    avatar: user.avatar || "",
    about: user.about || "",
    status: user.status || "Available",
});

const postImages = (post: any): string[] => {
    const images: string[] = Array.isArray(post.images)
        ? post.images.filter((image: unknown): image is string => typeof image === "string" && Boolean(image.trim()))
        : [];
    if (typeof post.image === "string" && post.image.trim() && !images.includes(post.image)) images.unshift(post.image);
    return images.slice(0, 10);
};

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

const serializeMoment = (moment: any, userId: string) => ({
    id: moment._id.toString(),
    title: moment.title,
    owner: publicUser(moment.owner),
    contributors: (moment.contributors || []).filter(Boolean).map(publicUser),
    entries: (moment.entries || []).map((entry: any) => ({
        id: entry._id.toString(),
        author: publicUser(entry.author),
        image: entry.image,
        caption: entry.caption || "",
        createdAt: entry.createdAt,
    })),
    isOwner: moment.owner?._id?.toString() === userId,
    canContribute: moment.owner?._id?.toString() === userId
        || (moment.contributors || []).some((contributor: any) => contributor?._id?.toString() === userId),
    createdAt: moment.createdAt,
    updatedAt: moment.updatedAt,
});

const emitMomentsChanged = (io: SocketIoServer, userIds: string[]) => {
    const recipients = new Set(userIds);
    for (const client of io.sockets.sockets.values()) {
        if (recipients.has(String(client.data.userId))) client.emit("momentsChanged", { success: true });
    }
};

export function registerUserEvents(socket: Socket, io: SocketIoServer) {
    socket.on("getMoments", async () => {
        try {
            const userId = String(socket.data.userId);
            const moments = await Moment.find({ $or: [{ owner: userId }, { contributors: userId }] })
                .sort({ updatedAt: -1 })
                .limit(30)
                .populate("owner", "name email avatar")
                .populate("contributors", "name email avatar")
                .populate("entries.author", "name email avatar")
                .lean();
            socket.emit("getMoments", { success: true, data: moments.map((moment: any) => serializeMoment(moment, userId)) });
        } catch (error) {
            console.error("getMoments error", error);
            socket.emit("getMoments", { success: false, msg: "Could not load Moments" });
        }
    });

    socket.on("createMoment", async (data: { title?: string; contributorIds?: string[] }) => {
        try {
            const userId = String(socket.data.userId);
            const title = String(data?.title || "").trim();
            if (!title) return socket.emit("createMoment", { success: false, msg: "Give your Moment a title" });
            const requestedIds = [...new Set((Array.isArray(data?.contributorIds) ? data.contributorIds : []).map(String))]
                .filter((id) => isValidObjectId(id) && id !== userId)
                .slice(0, 12);
            const friendIds = await friendIdsFor(userId);
            const contributorIds = requestedIds.filter((id) => friendIds.includes(id));
            if (contributorIds.length !== requestedIds.length) {
                return socket.emit("createMoment", { success: false, msg: "Only current friends can contribute" });
            }
            const created = await Moment.create({
                owner: new Types.ObjectId(userId),
                title: title.slice(0, 100),
                contributors: contributorIds.map((id) => new Types.ObjectId(id)),
            });
            socket.emit("createMoment", { success: true, data: { momentId: created._id.toString() }, msg: "Moment created" });
            emitMomentsChanged(io, [userId, ...contributorIds]);
            void createActivities({
                recipientIds: contributorIds,
                actorId: userId,
                type: "moment_invite",
                title: "A Moment to share",
                body: `${socket.data.user?.name || "A friend"} invited you to add photos to ${title}`,
                data: { url: "/(main)/moments", momentId: created._id.toString() },
            });
        } catch (error) {
            console.error("createMoment error", error);
            socket.emit("createMoment", { success: false, msg: "Could not create this Moment" });
        }
    });

    socket.on("addMomentEntry", async (data: { momentId?: string; image?: string; caption?: string }) => {
        try {
            const userId = String(socket.data.userId);
            const image = String(data?.image || "").trim();
            if (!data?.momentId || !isValidObjectId(data.momentId) || !/^https?:\/\//i.test(image)) {
                return socket.emit("addMomentEntry", { success: false, msg: "Choose a valid photo" });
            }
            const moment: any = await Moment.findOne({ _id: data.momentId, $or: [{ owner: userId }, { contributors: userId }] });
            if (!moment) return socket.emit("addMomentEntry", { success: false, msg: "You cannot contribute to this Moment" });
            if (moment.entries.length >= 250) return socket.emit("addMomentEntry", { success: false, msg: "This Moment has reached its photo limit" });
            moment.entries.push({ author: new Types.ObjectId(userId), image, caption: String(data?.caption || "").trim().slice(0, 300) });
            await moment.save();
            const memberIds = [moment.owner.toString(), ...moment.contributors.map((id: any) => id.toString())];
            socket.emit("addMomentEntry", { success: true, data: { momentId: moment._id.toString() }, msg: "Photo added" });
            emitMomentsChanged(io, memberIds);
            void createActivities({
                recipientIds: memberIds,
                actorId: userId,
                type: "moment_photo",
                title: "New Moment photo",
                body: `${socket.data.user?.name || "A friend"} added a photo to ${moment.title}`,
                data: { url: "/(main)/moments", momentId: moment._id.toString() },
            });
        } catch (error) {
            console.error("addMomentEntry error", error);
            socket.emit("addMomentEntry", { success: false, msg: "Could not add this photo" });
        }
    });

    socket.on("deleteMoment", async (data: { momentId?: string }) => {
        try {
            const userId = String(socket.data.userId);
            if (!data?.momentId || !isValidObjectId(data.momentId)) return;
            const moment: any = await Moment.findOneAndDelete({ _id: data.momentId, owner: userId });
            if (!moment) return socket.emit("deleteMoment", { success: false, msg: "Only the creator can delete this Moment" });
            const memberIds = [userId, ...moment.contributors.map((id: any) => id.toString())];
            socket.emit("deleteMoment", { success: true, data: { momentId: data.momentId } });
            emitMomentsChanged(io, memberIds);
        } catch (error) {
            console.error("deleteMoment error", error);
            socket.emit("deleteMoment", { success: false, msg: "Could not delete this Moment" });
        }
    });

    socket.on("getActivityDigest", async () => {
        try {
            const userId = String(socket.data.userId);
            const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const [activities, unreadCount] = await Promise.all([
                Activity.find({ recipient: userId, createdAt: { $gte: since } })
                    .sort({ createdAt: -1 })
                    .limit(12)
                    .populate("actor", "name avatar")
                    .lean(),
                Activity.countDocuments({ recipient: userId, readAt: null }),
            ]);
            const counts = activities.reduce<Record<string, number>>((summary, activity: any) => {
                summary[activity.type] = (summary[activity.type] || 0) + 1;
                return summary;
            }, {});
            socket.emit("getActivityDigest", {
                success: true,
                data: {
                    unreadCount,
                    counts,
                    items: activities.map((activity: any) => ({
                        id: activity._id.toString(),
                        type: activity.type,
                        title: activity.title,
                        body: activity.body,
                        data: activity.data || {},
                        read: Boolean(activity.readAt),
                        createdAt: activity.createdAt,
                        actor: activity.actor ? publicUser(activity.actor) : null,
                    })),
                },
            });
        } catch (error) {
            console.error("getActivityDigest error", error);
            socket.emit("getActivityDigest", { success: false, msg: "Could not prepare your activity summary" });
        }
    });

    socket.on("markActivitiesRead", async () => {
        try {
            const userId = String(socket.data.userId);
            await Activity.updateMany({ recipient: userId, readAt: null }, { $set: { readAt: new Date() } });
            socket.emit("markActivitiesRead", { success: true });
        } catch (error) {
            console.error("markActivitiesRead error", error);
            socket.emit("markActivitiesRead", { success: false, msg: "Could not mark activity as seen" });
        }
    });

    socket.on("clearActivities", async () => {
        try {
            const userId = String(socket.data.userId);
            await Activity.deleteMany({ recipient: userId });
            socket.emit("clearActivities", { success: true });
        } catch (error) {
            console.error("clearActivities error", error);
            socket.emit("clearActivities", { success: false, msg: "Could not clear activity" });
        }
    });

    socket.on("registerPushToken", async (data: { token?: string }) => {
        try {
            const token = String(data?.token || "").trim();
            if (!/^(ExponentPushToken|ExpoPushToken)\[.+\]$/.test(token)) {
                return socket.emit("registerPushToken", { success: false, msg: "Invalid push token" });
            }
            await User.updateMany({ _id: { $ne: socket.data.userId }, pushTokens: token }, { $pull: { pushTokens: token } });
            await User.findByIdAndUpdate(socket.data.userId, { $addToSet: { pushTokens: token } });
            socket.emit("registerPushToken", { success: true });
        } catch (error) {
            console.error("registerPushToken error", error);
            socket.emit("registerPushToken", { success: false, msg: "Could not register notifications" });
        }
    });

    socket.on("unregisterPushToken", async (data: { token?: string }) => {
        try {
            const token = String(data?.token || "").trim();
            if (token) await User.findByIdAndUpdate(socket.data.userId, { $pull: { pushTokens: token } });
            socket.emit("unregisterPushToken", { success: true });
        } catch (error) {
            console.error("unregisterPushToken error", error);
        }
    });
  
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
            const viewerId = String(socket.data.userId || "");
            const requestedId = String(data?.userId || viewerId);
            if (!isValidObjectId(requestedId)) {
                return socket.emit("getUserProfile", { success: false, msg: "Invalid user" });
            }
            const profile = await User.findById(requestedId).select("name email avatar about status mobile created").lean();
            if (!profile) return socket.emit("getUserProfile", { success: false, msg: "User not found" });
            const canViewPrivate = requestedId === viewerId || (await friendIdsFor(viewerId)).includes(requestedId);
            socket.emit("getUserProfile", {
                success: true,
                data: {
                    id: profile._id.toString(),
                    name: profile.name,
                    avatar: profile.avatar || "",
                    about: profile.about || "",
                    status: profile.status || "Available",
                    joinedAt: profile.created,
                    canViewPrivate,
                    ...(canViewPrivate ? { email: profile.email, mobile: profile.mobile || "" } : {}),
                },
            });
        } catch (error) {
            console.error("getUserProfile error", error);
            socket.emit("getUserProfile", { success: false, msg: "Could not load profile" });
        }
    });

    socket.on("getUserPosts", async (data: { userId?: string; cursor?: string; limit?: number }) => {
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
            const requestedLimit = Number(data?.limit);
            const pageSize = Number.isFinite(requestedLimit)
                ? Math.min(Math.max(Math.trunc(requestedLimit), 5), 20)
                : 50;
            const cursor = String(data?.cursor || "");
            let cursorFilter = {};

            if (cursor && isValidObjectId(cursor)) {
                const cursorPost = await Post.findOne({ _id: cursor, author: requestedId }).select("createdAt").lean();
                if (cursorPost) {
                    cursorFilter = {
                        $or: [
                            { createdAt: { $lt: cursorPost.createdAt } },
                            { createdAt: cursorPost.createdAt, _id: { $lt: cursorPost._id } },
                        ],
                    };
                }
            }

            const posts = await Post.find({ author: requestedId, ...cursorFilter })
                .sort({ createdAt: -1 })
                .limit(pageSize + 1)
                .populate("author", "name avatar about status mobile")
                .populate("comments.author", "name avatar")
                .lean();
            const hasMore = posts.length > pageSize;
            const page = hasMore ? posts.slice(0, pageSize) : posts;
            let highlights;
            if (!cursor) {
                const photoFilter = {
                    author: requestedId,
                    $or: [
                        { image: { $exists: true, $nin: ["", null] } },
                        { "images.0": { $exists: true } },
                    ],
                };
                const [friendCount, relationships, photoPosts] = await Promise.all([
                    FriendRequest.countDocuments({
                        status: "accepted",
                        $or: [{ sender: requestedId }, { recipient: requestedId }],
                    }),
                    FriendRequest.find({
                        status: "accepted",
                        $or: [{ sender: requestedId }, { recipient: requestedId }],
                    })
                        .sort({ updatedAt: -1 })
                        .populate("sender", "name avatar")
                        .populate("recipient", "name avatar")
                        .lean(),
                    Post.find(photoFilter).sort({ createdAt: -1 }).select("image images").lean(),
                ]);
                const photos = photoPosts.flatMap((photo: any) => postImages(photo).map((image, index) => ({
                    id: `${photo._id.toString()}-${index}`,
                    image,
                })));
                highlights = {
                    friendsCount: friendCount,
                    friends: relationships.map((relationship: any) => {
                        const senderId = relationship.sender?._id?.toString();
                        const friend = senderId === requestedId ? relationship.recipient : relationship.sender;
                        return friend ? publicUser(friend) : null;
                    }).filter(Boolean),
                    photosCount: photos.length,
                    photos,
                };
            }
            socket.emit("getUserPosts", {
                success: true,
                data: page.map((post: any) => ({
                    id: post._id.toString(),
                    author: publicUser(post.author),
                    kind: post.kind || "post",
                    content: post.content,
                    image: postImages(post)[0] || "",
                    images: postImages(post),
                    likesCount: post.likes?.length || 0,
                    likedByMe: post.likes?.some((id: any) => id.toString() === viewerId) || false,
                    commentsCount: post.comments?.length || 0,
                    comments: (post.comments || []).map((comment: any) => ({
                        id: comment._id.toString(),
                        author: publicUser(comment.author),
                        content: comment.content,
                        createdAt: comment.createdAt,
                    })),
                    createdAt: post.createdAt,
                })),
                pagination: {
                    hasMore,
                    nextCursor: hasMore ? page[page.length - 1]?._id.toString() || null : null,
                    requestCursor: cursor || null,
                },
                ...(highlights ? { highlights } : {}),
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
                    .select("_id participants clearedAtBy")
                    .lean(),
            ]);

            const directConversationIds = directConversations.map((conversation) => conversation._id);
            const unreadGroups = directConversationIds.length ? await Promise.all(
                directConversations.map(async (conversation: any) => {
                    const stored = conversation.clearedAtBy instanceof Map
                        ? conversation.clearedAtBy.get(userId)
                        : conversation.clearedAtBy?.[userId];
                    const clearedAt = stored ? new Date(stored) : null;
                    const count = await Message.countDocuments({
                        conversationId: conversation._id,
                        senderId: { $ne: new Types.ObjectId(userId) },
                        readBy: { $exists: true, $ne: new Types.ObjectId(userId) },
                        ...(clearedAt ? { createdAt: { $gt: clearedAt } } : {}),
                        $or: [
                            { expiresAt: null },
                            { expiresAt: { $exists: false } },
                            { expiresAt: { $gt: new Date() } },
                        ],
                    });
                    return { _id: conversation._id, count };
                })
            ) : [];
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
            void createActivities({
                recipientIds: [recipientId],
                actorId: senderId,
                type: "friend_request",
                title: "New friend request",
                body: `${socket.data.user?.name || "Someone"} sent you a friend request`,
                data: { url: "/(main)/main?tab=community", section: "requests" },
            });
        } catch (error) {
            console.error("sendFriendRequest error", error);
            socket.emit("sendFriendRequest", { success: false, msg: "Could not send request" });
        }
    });

    socket.on("cancelFriendRequest", async (data: { requestId?: string }) => {
        try {
            const senderId = String(socket.data.userId);
            if (!data?.requestId || !isValidObjectId(data.requestId)) {
                return socket.emit("cancelFriendRequest", { success: false, msg: "Invalid request", data: { requestId: data?.requestId } });
            }
            const request = await FriendRequest.findOneAndDelete({
                _id: data.requestId,
                sender: senderId,
                status: "pending",
            });
            if (!request) {
                return socket.emit("cancelFriendRequest", { success: false, msg: "Request is no longer available", data: { requestId: data.requestId } });
            }
            socket.emit("cancelFriendRequest", { success: true, msg: "Friend request canceled", data: { requestId: data.requestId } });
            notifyFriendDataChanged(io, [request.sender.toString(), request.recipient.toString()]);
        } catch (error) {
            console.error("cancelFriendRequest error", error);
            socket.emit("cancelFriendRequest", { success: false, msg: "Could not cancel request", data: { requestId: data?.requestId } });
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

    socket.on("getFeed", async (data?: { cursor?: string; limit?: number }) => {
        try {
            const userId = String(socket.data.userId);
            const friendIds = await friendIdsFor(userId);
            const requestedLimit = Number(data?.limit);
            const pageSize = Number.isFinite(requestedLimit)
                ? Math.min(Math.max(Math.trunc(requestedLimit), 5), 20)
                : 50;
            const cursor = String(data?.cursor || "");
            let cursorFilter = {};

            if (cursor && isValidObjectId(cursor)) {
                const cursorPost = await Post.findById(cursor).select("createdAt").lean();
                if (cursorPost) {
                    cursorFilter = {
                        $or: [
                            { createdAt: { $lt: cursorPost.createdAt } },
                            { createdAt: cursorPost.createdAt, _id: { $lt: cursorPost._id } },
                        ],
                    };
                }
            }

            const posts = await Post.find({
                author: { $in: [userId, ...friendIds] },
                ...cursorFilter,
            })
                .sort({ createdAt: -1 })
                .limit(pageSize + 1)
                .populate("author", "name avatar")
                .populate("taggedUsers", "name avatar")
                .populate("comments.author", "name avatar")
                .lean();
            const hasMore = posts.length > pageSize;
            const page = hasMore ? posts.slice(0, pageSize) : posts;
            socket.emit("getFeed", {
                success: true,
                // Keep data as an array so older app versions can still consume it.
                data: page.map((post: any) => ({
                    id: post._id.toString(),
                    author: publicUser(post.author),
                    content: post.content,
                    image: postImages(post)[0] || "",
                    images: postImages(post),
                    taggedUsers: (post.taggedUsers || []).filter(Boolean).map(publicUser),
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
                pagination: {
                    hasMore,
                    nextCursor: hasMore ? page[page.length - 1]?._id.toString() || null : null,
                    requestCursor: cursor || null,
                },
            });
        } catch (error) {
            console.error("getFeed error", error);
            socket.emit("getFeed", { success: false, msg: "Could not load feed" });
        }
    });

    socket.on("createPost", async (data: { content?: string; image?: string; images?: string[]; taggedUserIds?: string[] }) => {
        try {
            const userId = String(socket.data.userId);
            const content = String(data?.content || "").trim();
            const images = Array.from(new Set([
                ...(Array.isArray(data?.images) ? data.images : []),
                ...(typeof data?.image === "string" ? [data.image] : []),
            ].map((image) => String(image).trim()).filter(Boolean))).slice(0, 10);
            if (!content && !images.length) return socket.emit("createPost", { success: false, msg: "Write something or add a photo" });
            const requestedTagIds = Array.from(new Set(Array.isArray(data?.taggedUserIds) ? data.taggedUserIds.map(String) : []))
                .filter((id) => isValidObjectId(id) && id !== userId)
                .slice(0, 10);
            const friendIds = await friendIdsFor(userId);
            const taggedUsers = requestedTagIds.filter((id) => friendIds.includes(id));
            if (taggedUsers.length !== requestedTagIds.length) {
                return socket.emit("createPost", { success: false, msg: "You can only tag current friends" });
            }
            const post = await Post.create({
                author: new Types.ObjectId(userId),
                content,
                image: images[0] || "",
                images,
                taggedUsers: taggedUsers.map((id) => new Types.ObjectId(id)),
            });
            socket.emit("createPost", { success: true, msg: "Posted" });
            if (taggedUsers.length) {
                void createActivities({
                    recipientIds: taggedUsers,
                    actorId: userId,
                    type: "post_tag",
                    title: "You were tagged",
                    body: `${socket.data.user?.name || "A friend"} tagged you in a post`,
                    data: { url: "/(main)/main?tab=community", postId: post._id.toString() },
                });
            }
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

    socket.on("deletePostComment", async (data: { postId?: string; commentId?: string }) => {
        try {
            const userId = String(socket.data.userId);
            if (!data?.postId || !data?.commentId || !isValidObjectId(data.postId) || !isValidObjectId(data.commentId)) {
                return socket.emit("deletePostComment", { success: false, msg: "Invalid comment" });
            }

            const post = await Post.findOne({
                _id: data.postId,
                "comments._id": data.commentId,
                $or: [
                    { author: userId },
                    { comments: { $elemMatch: { _id: data.commentId, author: userId } } },
                ],
            }).select("author");
            if (!post) {
                return socket.emit("deletePostComment", { success: false, msg: "Comment not found or not allowed" });
            }

            await Post.updateOne(
                { _id: post._id },
                { $pull: { comments: { _id: new Types.ObjectId(data.commentId) } } }
            );
            socket.emit("deletePostComment", {
                success: true,
                data: { postId: data.postId, commentId: data.commentId },
            });

            const authorId = post.author.toString();
            const viewers = [authorId, ...(await friendIdsFor(authorId))];
            for (const client of io.sockets.sockets.values()) {
                if (viewers.includes(String(client.data.userId))) client.emit("feedChanged", { success: true });
            }
        } catch (error) {
            console.error("deletePostComment error", error);
            socket.emit("deletePostComment", { success: false, msg: "Could not delete comment" });
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
