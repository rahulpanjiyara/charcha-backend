import type { Request, Response } from "express";
import User from "../modals/User.js";
import bcrypt from "bcryptjs";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { generateToken } from "../utils/token.js";
import { sendPasswordResetEmail } from "../utils/email.js";
import { isValidMobile, mobileLookup, normalizeEmail, normalizeMobile } from "../utils/identity.js";




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
