import { model, Schema } from "mongoose";

const commentSchema = new Schema(
  {
    author: { type: Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true, trim: true, maxlength: 500 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const postSchema = new Schema(
  {
    author: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: ["post", "moment"], default: "post" },
    content: { type: String, trim: true, maxlength: 2000, default: "" },
    image: { type: String, default: "" },
    images: {
      type: [String],
      default: [],
      validate: { validator: (images: string[]) => images.length <= 10, message: "A post can contain up to 10 photos" },
    },
    taggedUsers: [{ type: Schema.Types.ObjectId, ref: "User" }],
    likes: [{ type: Schema.Types.ObjectId, ref: "User" }],
    comments: { type: [commentSchema], default: [] },
  },
  { timestamps: true }
);

postSchema.index({ author: 1, createdAt: -1 });

export default model("Post", postSchema);
