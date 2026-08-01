import jwt from 'jsonwebtoken';
import type { UserProps } from '../types.js';

export const generateToken=(user:UserProps)=>{
    const payload={
        user:{
            id:user._id,
            email:user.email,
            name:user.name,
            avatar:user.avatar,
            about:user.about || "",
            status:user.status || "Available",
            mobile:user.mobile || ""
        }
    }
    return jwt.sign(payload,process.env.JWT_SECRET as string,{expiresIn:'30d'});
}
