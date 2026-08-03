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

type ExpoPushTicket = {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
};

type ExpoPushReceipt = {
  status: "ok" | "error";
  message?: string;
  details?: { error?: string };
};

const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_PUSH_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const PUSH_RECEIPT_DELAY_MS = 15 * 60 * 1000;

const tokenLabel = (token: string) => `…${token.slice(-10)}`;

async function removeExpiredPushToken(token: string) {
  await User.updateMany({ pushTokens: token }, { $pull: { pushTokens: token } });
}

async function checkPushReceipts(ticketTokens: Map<string, string>) {
  if (!ticketTokens.size) return;
  try {
    const response = await fetch(EXPO_PUSH_RECEIPTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ids: [...ticketTokens.keys()] }),
    });
    const payload = await response.json() as { data?: Record<string, ExpoPushReceipt>; errors?: unknown };
    if (!response.ok) {
      console.error("Expo push receipt request failed", response.status, payload);
      return;
    }
    for (const [ticketId, receipt] of Object.entries(payload.data || {})) {
      if (receipt.status !== "error") continue;
      const token = ticketTokens.get(ticketId);
      const code = receipt.details?.error || "UnknownError";
      console.error("Expo push delivery failed", { code, message: receipt.message, token: token ? tokenLabel(token) : "unknown" });
      if (code === "DeviceNotRegistered" && token) await removeExpiredPushToken(token);
    }
  } catch (error) {
    console.error("Could not check Expo push receipts", error);
  }
}

export async function sendPushToUsers(userIds: string[], title: string, body: string, data: Record<string, unknown> = {}) {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  if (!uniqueIds.length) return;
  const users = await User.find({ _id: { $in: uniqueIds } }).select("pushTokens").lean();
  const tokens = [...new Set(users.flatMap((user: any) => user.pushTokens || []))]
    .filter((token) => typeof token === "string" && /^(ExponentPushToken|ExpoPushToken)\[.+\]$/.test(token));
  if (!tokens.length) return;
  const ticketTokens = new Map<string, string>();
  for (let offset = 0; offset < tokens.length; offset += 100) {
    const tokenBatch = tokens.slice(offset, offset + 100);
    const messages = tokenBatch.map((to) => ({
      to,
      sound: "default",
      title,
      body,
      data,
      channelId: "charcha-activity",
      priority: "high",
    }));
    try {
      const response = await fetch(EXPO_PUSH_SEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(messages),
      });
      const payload = await response.json() as { data?: ExpoPushTicket[]; errors?: unknown };
      if (!response.ok) {
        console.error("Expo push request failed", response.status, payload);
        continue;
      }
      (payload.data || []).forEach((ticket, index) => {
        const token = tokenBatch[index];
        if (ticket.status === "ok" && ticket.id) {
          ticketTokens.set(ticket.id, token);
          return;
        }
        const code = ticket.details?.error || "UnknownError";
        console.error("Expo rejected push notification", { code, message: ticket.message, token: tokenLabel(token) });
        if (code === "DeviceNotRegistered") void removeExpiredPushToken(token);
      });
    } catch (error) {
      console.error("Could not send push notification", error);
    }
  }

  if (ticketTokens.size) {
    const receiptTimer = setTimeout(() => void checkPushReceipts(ticketTokens), PUSH_RECEIPT_DELAY_MS);
    receiptTimer.unref?.();
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
