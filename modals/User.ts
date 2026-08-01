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
        maxlength:24,
    },
    created:{
        type:Date,
        default:Date.now,
    }
});

const User = model<UserProps>('User',userSchema);
export default User;
