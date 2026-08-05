import { Document, Types } from "mongoose";

export interface UserProps extends Document {
  email: string;
  password: string;
  name?: string;
  avatar?: string;
  about?: string;
  status?: string;
  mobile?: string;
  pushTokens?: string[];
  blockedUsers?: Types.ObjectId[];
  passwordResetCodeHash?: string;
  passwordResetExpiresAt?: Date;
  passwordResetRequestedAt?: Date;
  passwordResetAttempts?: number;
  created?: Date;
}

export interface ConversationProps extends Document {
  _id: Types.ObjectId;
  type: "direct" | "group";
  name?: string;
  participants: Types.ObjectId[];
  lastMessage?: Types.ObjectId;
  createdBy?: Types.ObjectId;
  avatar?: string;
  disappearingMessagesSeconds: number;
  createdAt: Date;
  updatedAt: Date;
  deletedFor:Types.ObjectId[]
  clearedAtBy: Map<string, Date>;
}
