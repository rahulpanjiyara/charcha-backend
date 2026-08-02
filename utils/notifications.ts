import Activity from "../modals/Activity.js";
import User from "../modals/User.js";

type ActivityInput = {
  recipientIds: string[];
  actorId?: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  push?: boolean;
};

export async function sendPushToUsers(userIds: string[], title: string, body: string, data: Record<string, unknown> = {}) {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  if (!uniqueIds.length) return;
  const users = await User.find({ _id: { $in: uniqueIds } }).select("pushTokens").lean();
  const tokens = [...new Set(users.flatMap((user: any) => user.pushTokens || []))]
    .filter((token) => typeof token === "string" && /^(ExponentPushToken|ExpoPushToken)\[.+\]$/.test(token));
  if (!tokens.length) return;
  const messages = tokens.map((to) => ({ to, sound: "default", title, body, data, channelId: "charcha-activity" }));
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(messages),
    });
    if (!response.ok) console.error("Expo push request failed", response.status, await response.text());
  } catch (error) {
    console.error("Could not send push notification", error);
  }
}

export async function createActivities(input: ActivityInput) {
  try {
    const recipientIds = [...new Set(input.recipientIds.filter((id) => id && id !== input.actorId))];
    if (!recipientIds.length) return;
    await Activity.insertMany(recipientIds.map((recipient) => ({
      recipient,
      actor: input.actorId,
      type: input.type,
      title: input.title,
      body: input.body,
      data: input.data || {},
    })));
    if (input.push !== false) await sendPushToUsers(recipientIds, input.title, input.body, input.data || {});
  } catch (error) {
    // Notification failures must never interrupt the user action that created them.
    console.error("Could not create activity notifications", error);
  }
}
