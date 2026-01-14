import type { Socket, Server as SocketIoServer } from "socket.io";
import User from "../modals/User.js";
import { generateToken } from "../utils/token.js";

export function registerUserEvents(socket: Socket, io: SocketIoServer) {
  
    socket.on("updateProfile", async (data: { name?: string; avatar?: string }) => {
        //console.log('updateprofile event', data);

        const userId = socket.data.userId;
        if (!userId) {
            return socket.emit('updateProfile', {
                success: false, message: "Unauthorised"
            })

        }
        try {
            const updatedUser = await User.findByIdAndUpdate(userId, { name: data.name, avatar: data.avatar }, { new: true })
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
                success: false, message: "Error updating profile"
            })
        }
    })

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
            const users = await User.find({_id:{$ne:currentUserId}},{password:0}).lean();
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