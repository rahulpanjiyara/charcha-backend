import type { Request, Response } from "express";
import User from "../modals/User.js";
import bcrypt from "bcryptjs";
import { generateToken } from "../utils/token.js";




export const registerUser = async (req: Request, res: Response): Promise<void> => {
    // Registration logic here
    const { email, password, name, avatar } = req.body;
    try {
        let user = await User.findOne({ email });
        if (user) {
            res.status(400).json({ success: false, message: "User already exists" });
            return;
        }
        user = new User({
            email,
            password,
            name,
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

    } catch (error) {
        console.log('Error in user registration:', error);
        res.status(500).json({ message: "Server error" });
    }
};

export const loginUser = async (req: Request, res: Response): Promise<void> => {
    const { email, password } = req.body;
    try {
        //find the user by email
        const user = await User.findOne({ email });
        if (!user) {
            res.status(400).json({ success: false, message: "User does not exist" });
            return;
        }

        //compare password
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            res.status(400).json({ success: false, message: "Invalid credentials" });
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