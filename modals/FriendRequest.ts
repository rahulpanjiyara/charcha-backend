import { model, Schema } from "mongoose";

const friendRequestSchema = new Schema(
  {
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    recipient: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected"],
      default: "pending",
      required: true,
    },
  },
  { timestamps: true }
);

friendRequestSchema.index({ sender: 1, recipient: 1 }, { unique: true });
friendRequestSchema.index({ recipient: 1, status: 1, createdAt: -1 });

export default model("FriendRequest", friendRequestSchema);
