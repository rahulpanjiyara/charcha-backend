import { model, Schema } from "mongoose";

const momentEntrySchema = new Schema(
  {
    author: { type: Schema.Types.ObjectId, ref: "User", required: true },
    image: { type: String, required: true, trim: true },
    caption: { type: String, trim: true, maxlength: 300, default: "" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const momentSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 100 },
    contributors: [{ type: Schema.Types.ObjectId, ref: "User" }],
    entries: { type: [momentEntrySchema], default: [] },
  },
  { timestamps: true }
);

momentSchema.index({ contributors: 1, updatedAt: -1 });

export default model("Moment", momentSchema);
