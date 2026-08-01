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
    readBy:[{
        type:mongoose.Schema.Types.ObjectId,
        ref:"User",
    }],

},{
    timestamps:true,
});
messageSchema.index({ conversationId: 1, createdAt: -1 });
messageSchema.index({ conversationId: 1, readBy: 1, senderId: 1 });
const Message = mongoose.model("Message",messageSchema);
export default Message;
