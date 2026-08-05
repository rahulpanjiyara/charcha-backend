import type { Request, Response } from "express";
import User from "../modals/User.js";
import bcrypt from "bcryptjs";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { generateToken } from "../utils/token.js";
import { sendPasswordResetEmail } from "../utils/email.js";
import { isValidMobile, mobileLookup, normalizeEmail, normalizeMobile } from "../utils/identity.js";
import Activity from "../modals/Activity.js";
import Conversation from "../modals/Conversation.js";
import FriendRequest from "../modals/FriendRequest.js";
import Message from "../modals/Message.js";
import Moment from "../modals/Moment.js";
import Post from "../modals/Post.js";




export const registerUser = async (req: Request, res: Response): Promise<void> => {
    const email = normalizeEmail(req.body?.email);
    const mobile = normalizeMobile(req.body?.mobile);
    const password = String(req.body?.password || "");
    const name = String(req.body?.name || "").trim();
    const avatar = typeof req.body?.avatar === "string" ? req.body.avatar : "";

    if (!name || !/^\S+@\S+\.\S+$/.test(email) || !isValidMobile(mobile) || password.length < 8) {
        res.status(400).json({
            success: false,
            message: "Enter a valid full name, email and mobile number, and use at least 8 password characters",
        });
        return;
    }
    try {
        let user = await User.findOne({ $or: [{ email }, { mobile: mobileLookup(mobile) }] });
        if (user) {
            res.status(409).json({ success: false, message: user.email === email ? "Email is already registered" : "Mobile number is already registered" });
            return;
        }
        user = new User({
            email,
            password,
            name,
            mobile,
            avatar
        });
        //hash the password before saving (omitted for brevity)
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(password, salt);
        await user.save();
        //generate token (omitted for brevity)
        const token = generateToken(user);

        res.status(201).json({
            success: true,
            message: "User registered successfully",
            token
        })

    } catch (error: any) {
        console.log('Error in user registration:', error);
        if (error?.code === 11000) {
            res.status(409).json({ success: false, message: "User already exists" });
            return;
        }
        res.status(500).json({ message: "Server error" });
    }
};

export const loginUser = async (req: Request, res: Response): Promise<void> => {
    const identifier = String(req.body?.identifier || req.body?.email || "").trim();
    const password = String(req.body?.password || "");
    if (!identifier || !password) {
        res.status(400).json({ success: false, message: "Email or mobile number and password are required" });
        return;
    }
    try {
        const isEmail = identifier.includes("@");
        const normalizedMobile = normalizeMobile(identifier);
        if (!isEmail && !isValidMobile(normalizedMobile)) {
            res.status(401).json({ success: false, message: "Invalid email/mobile number or password" });
            return;
        }
        const user = await User.findOne(isEmail
            ? { email: normalizeEmail(identifier) }
            : { mobile: mobileLookup(normalizedMobile) });
        if (!user) {
            res.status(401).json({ success: false, message: "Invalid email/mobile number or password" });
            return;
        }

        //compare password
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            res.status(401).json({ success: false, message: "Invalid email/mobile number or password" });
            return;
        }
        //generate token
        const token = generateToken(user);
        res.status(200).json({
            success: true,
            message: "User logged in successfully",
            token
        });
    } catch (error) {
        console.log('Error Login:', error);
        res.status(500).json({ message: "Server error" });
    }
};

const RESET_CODE_LIFETIME_MS = 10 * 60 * 1000;
const RESET_REQUEST_COOLDOWN_MS = 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;

const hashResetCode = (code: string) =>
    createHmac("sha256", String(process.env.JWT_SECRET || "charcha-reset"))
        .update(code)
        .digest("hex");

const findUserByIdentifier = (identifier: string) => {
    if (identifier.includes("@")) return User.findOne({ email: normalizeEmail(identifier) });
    const mobile = normalizeMobile(identifier);
    if (!isValidMobile(mobile)) return null;
    return User.findOne({ mobile: mobileLookup(mobile) });
};

export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
    const identifier = String(req.body?.identifier || "").trim();
    if (!identifier) {
        res.status(400).json({ success: false, message: "Enter your email or mobile number" });
        return;
    }

    const successMessage = "If an account matches, a reset code has been sent to its registered email.";
    try {
        const query = findUserByIdentifier(identifier);
        if (!query) {
            res.status(200).json({ success: true, message: successMessage });
            return;
        }
        const user = await query.select("+passwordResetRequestedAt");
        if (!user) {
            res.status(200).json({ success: true, message: successMessage });
            return;
        }

        const lastRequest = user.passwordResetRequestedAt?.getTime() || 0;
        if (Date.now() - lastRequest < RESET_REQUEST_COOLDOWN_MS) {
            res.status(200).json({ success: true, message: successMessage });
            return;
        }

        const code = randomInt(100000, 1000000).toString();
        user.passwordResetCodeHash = hashResetCode(code);
        user.passwordResetExpiresAt = new Date(Date.now() + RESET_CODE_LIFETIME_MS);
        user.passwordResetRequestedAt = new Date();
        user.passwordResetAttempts = 0;
        await user.save();

        try {
            await sendPasswordResetEmail({ to: user.email, name: user.name, code });
        } catch (error) {
            user.passwordResetCodeHash = undefined;
            user.passwordResetExpiresAt = undefined;
            user.passwordResetRequestedAt = undefined;
            user.passwordResetAttempts = 0;
            await user.save();
            console.error("Password reset email failed:", error);
            res.status(200).json({ success: true, message: successMessage });
            return;
        }

        res.status(200).json({ success: true, message: successMessage });
    } catch (error) {
        console.error("Forgot password error:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

export const resetPassword = async (req: Request, res: Response): Promise<void> => {
    const identifier = String(req.body?.identifier || "").trim();
    const code = String(req.body?.code || "").trim();
    const password = String(req.body?.password || "");
    if (!identifier || !/^\d{6}$/.test(code) || password.length < 8) {
        res.status(400).json({ success: false, message: "Enter the 6-digit code and a password of at least 8 characters" });
        return;
    }

    try {
        const query = findUserByIdentifier(identifier);
        const user = query
            ? await query.select("+passwordResetCodeHash +passwordResetExpiresAt +passwordResetAttempts")
            : null;
        if (!user || !user.passwordResetCodeHash || !user.passwordResetExpiresAt || user.passwordResetExpiresAt.getTime() < Date.now()) {
            res.status(400).json({ success: false, message: "The reset code is invalid or has expired" });
            return;
        }

        if ((user.passwordResetAttempts || 0) >= RESET_MAX_ATTEMPTS) {
            res.status(429).json({ success: false, message: "Too many attempts. Request a new reset code." });
            return;
        }

        const expected = Buffer.from(user.passwordResetCodeHash, "hex");
        const received = Buffer.from(hashResetCode(code), "hex");
        if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
            user.passwordResetAttempts = (user.passwordResetAttempts || 0) + 1;
            await user.save();
            res.status(400).json({ success: false, message: "The reset code is invalid or has expired" });
            return;
        }

        user.password = await bcrypt.hash(password, 10);
        user.passwordResetCodeHash = undefined;
        user.passwordResetExpiresAt = undefined;
        user.passwordResetRequestedAt = undefined;
        user.passwordResetAttempts = 0;
        await user.save();
        res.status(200).json({ success: true, message: "Password reset successfully" });
    } catch (error) {
        console.error("Reset password error:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

export const changePassword = async (req: Request, res: Response): Promise<void> => {
    const userId = getAuthenticatedUserId(req);
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");

    if (!userId) {
        res.status(401).json({ success: false, message: "Your session has expired. Please sign in again." });
        return;
    }
    if (!currentPassword || newPassword.length < 8) {
        res.status(400).json({ success: false, message: "Enter your current password and a new password of at least 8 characters" });
        return;
    }
    if (currentPassword === newPassword) {
        res.status(400).json({ success: false, message: "Choose a password different from your current password" });
        return;
    }

    try {
        const user = await User.findById(userId);
        if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
            res.status(403).json({ success: false, message: "The current password is incorrect" });
            return;
        }
        user.password = await bcrypt.hash(newPassword, 10);
        await user.save();
        res.status(200).json({ success: true, message: "Password changed successfully" });
    } catch (error) {
        console.error("Change password error:", error);
        res.status(500).json({ success: false, message: "Could not change the password. Please try again." });
    }
};

type AuthTokenPayload = { user?: { id?: string } };

const getAuthenticatedUserId = (req: Request) => {
    const authorization = String(req.headers.authorization || "");
    if (!authorization.startsWith("Bearer ")) return null;

    const token = authorization.slice(7).trim();
    if (!token || !process.env.JWT_SECRET) return null;

    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET) as AuthTokenPayload;
        return payload.user?.id || null;
    } catch {
        return null;
    }
};

export const deleteAccount = async (req: Request, res: Response): Promise<void> => {
    const userId = getAuthenticatedUserId(req);
    const password = String(req.body?.password || "");

    if (!userId) {
        res.status(401).json({ success: false, message: "Your session has expired. Please sign in again." });
        return;
    }
    if (!password) {
        res.status(400).json({ success: false, message: "Enter your current password to continue" });
        return;
    }

    try {
        const user = await User.findById(userId);
        if (!user) {
            res.status(401).json({ success: false, message: "Account not found" });
            return;
        }

        const passwordMatches = await bcrypt.compare(password, user.password);
        if (!passwordMatches) {
            res.status(403).json({ success: false, message: "The password you entered is incorrect" });
            return;
        }

        const conversations = await Conversation.find({ participants: user._id })
            .select("_id type participants createdBy")
            .lean();
        const directConversationIds = conversations
            .filter((conversation) => conversation.type === "direct")
            .map((conversation) => conversation._id);
        const groupConversations = conversations.filter((conversation) => conversation.type === "group");

        if (directConversationIds.length) {
            await Message.deleteMany({ conversationId: { $in: directConversationIds } });
            await Conversation.deleteMany({ _id: { $in: directConversationIds } });
        }

        await Message.deleteMany({ senderId: user._id });

        for (const conversation of groupConversations) {
            const remainingParticipants = conversation.participants.filter(
                (participant) => participant.toString() !== user._id.toString()
            );

            if (!remainingParticipants.length) {
                await Message.deleteMany({ conversationId: conversation._id });
                await Conversation.deleteOne({ _id: conversation._id });
                continue;
            }

            const latestMessage = await Message.findOne({ conversationId: conversation._id })
                .sort({ createdAt: -1 })
                .select("_id")
                .lean();
            const update: Record<string, any> = {
                $pull: { participants: user._id, deletedFor: user._id },
                $unset: { [`clearedAtBy.${user._id.toString()}`]: 1 },
            };
            const setFields: Record<string, any> = {};
            if (conversation.createdBy?.toString() === user._id.toString()) {
                setFields.createdBy = remainingParticipants[0];
            }
            if (latestMessage?._id) setFields.lastMessage = latestMessage._id;
            else update.$unset.lastMessage = 1;
            if (Object.keys(setFields).length) update.$set = setFields;
            await Conversation.updateOne({ _id: conversation._id }, update);
        }

        await Promise.all([
            Post.deleteMany({ author: user._id }),
            Post.updateMany(
                { author: { $ne: user._id } },
                { $pull: { taggedUsers: user._id, likes: user._id, comments: { author: user._id } } }
            ),
            Moment.deleteMany({ owner: user._id }),
            Moment.updateMany(
                { owner: { $ne: user._id } },
                { $pull: { contributors: user._id, entries: { author: user._id } } }
            ),
            FriendRequest.deleteMany({ $or: [{ sender: user._id }, { recipient: user._id }] }),
            Activity.deleteMany({ $or: [{ actor: user._id }, { recipient: user._id }] }),
            User.updateMany({ blockedUsers: user._id }, { $pull: { blockedUsers: user._id } }),
        ]);

        await User.deleteOne({ _id: user._id });
        res.status(200).json({ success: true, message: "Your Charcha account has been permanently deleted" });
    } catch (error) {
        console.error("Delete account error:", error);
        res.status(500).json({ success: false, message: "Could not delete the account. Please try again." });
    }
};
