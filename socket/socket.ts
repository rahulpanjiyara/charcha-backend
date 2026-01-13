import dotenv from 'dotenv';
dotenv.config();
import { Socket, Server as SocketIoServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import { register } from 'node:module';
import { registerUserEvents } from './userEvents.js';
import { registerChatEvents } from './chatEvents.js';
import Conversation from '../modals/Conversation.js';

export function initializeSocket(server: any): SocketIoServer {
    const io = new SocketIoServer(server, {
        cors: {
            origin: "*", //allow all regions for simplicity, adjust in production

        }
    });//socket io server instance

    io.use((socket: Socket, next) => {
        const token = socket.handshake.auth.token;
        if (!token) {
            return next(new Error("Authentication error: no token provided"));
        }
        jwt.verify(token, process.env.JWT_SECRET as string, (err: any, decoded: any) => {
            if (err) {
                return next(new Error("Authentication error: invalid token"));
            }
            //attach user info to socket
            let userData=decoded.user;
            socket.data=userData;
            socket.data.userId=userData.id;
            next();



        });

    });
    //when socket connects, register event handlers
    io.on('connection', async(socket: Socket) => {
        const userId = socket.data.userId;
        console.log(`User connected: ${socket.data.userId}, username: ${socket.data.name}`);

        //handle disconnection
        socket.on('disconnect', () => {
            console.log(`User disconnected: ${socket.data.userId},username: ${socket.data.name} `);
        });

        //additional event handlers can be added here

        registerUserEvents(socket, io);
        registerChatEvents(socket,io);

        // join all the converstion the user is part of
        try {
            const conversations = await Conversation.find({
                participants: userId
            }).select("_id");
            conversations.forEach(conversation=>{
                socket.join(conversation._id.toString());
            });
            
        } catch (error:any) {
            console.log("Error joining conversation", error)
            
        }
    });
    return io;
}
