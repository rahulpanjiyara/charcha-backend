import mongoose from "mongoose";


const messageSchema = new mongoose.Schema({
    conversationId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"Conversation",
        required:true
    },
    senderId:{
        type: mongoose.Schema.Types.ObjectId,
        ref:"User",
        required:true,
    },
    content:String,
    attachment:String,
    messageType: {
        type: String,
        enum: ["text", "image", "voice"],
        default: "text",
    },
    audioDuration: {
        type: Number,
        default: 0,
        min: 0,
        max: 600,
    },
    readBy:[{
        type:mongoose.Schema.Types.ObjectId,
        ref:"User",
    }],
    deliveredTo:[{
        type:mongoose.Schema.Types.ObjectId,
        ref:"User",
    }],
    expiresAt: {
        type: Date,
        default: null,
    },

},{
    timestamps:true,
});
messageSchema.index({ conversationId: 1, createdAt: -1 });
messageSchema.index({ conversationId: 1, readBy: 1, senderId: 1 });
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const Message = mongoose.model("Message",messageSchema);
export default Message;
