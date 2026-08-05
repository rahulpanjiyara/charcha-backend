import {Schema,model} from 'mongoose';
import type {UserProps} from "../types.js";

const userSchema = new Schema<UserProps>({
    email:{
        type:String,
        required:true,
        unique:true,
        lowercase:true,
        trim:true
    },
    password:{
        type:String,
        required:true,
    },
    name:{
        type:String,
        required:true,
    },
    avatar:{
        type:String,
        default:'',
    },
    about:{
        type:String,
        default:'',
        trim:true,
        maxlength:300,
    },
    status:{
        type:String,
        default:'Available',
        trim:true,
        maxlength:80,
    },
    mobile:{
        type:String,
        default:'',
        trim:true,
        maxlength:16,
    },
    passwordResetCodeHash: { type: String, select: false },
    passwordResetExpiresAt: { type: Date, select: false },
    passwordResetRequestedAt: { type: Date, select: false },
    passwordResetAttempts: { type: Number, default: 0, select: false },
    pushTokens: {
        type: [String],
        default: [],
    },
    blockedUsers: [{ type: Schema.Types.ObjectId, ref: "User" }],
    created:{
        type:Date,
        default:Date.now,
    }
});

const User = model<UserProps>('User',userSchema);
export default User;
