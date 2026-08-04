type SendPasswordResetEmailOptions = {
  to: string;
  name?: string;
  code: string;
};

export const sendPasswordResetEmail = async ({ to, name, code }: SendPasswordResetEmailOptions) => {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.RESEND_FROM_EMAIL || "Charcha <onboarding@resend.dev>").trim();

  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Reset your Charcha password",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#211a3b">
          <h1 style="color:#5b3fc4">Reset your Charcha password</h1>
          <p>Hello ${escapeHtml(name || "there")},</p>
          <p>Enter this verification code in Charcha:</p>
          <p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0">${code}</p>
          <p>This code expires in 10 minutes. If you did not request a password reset, you can ignore this email.</p>
        </div>
      `,
      text: `Hello ${name || "there"},\n\nYour Charcha password reset code is ${code}. It expires in 10 minutes.\n\nIf you did not request this, ignore this email.`,
    }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Resend request failed (${response.status}): ${responseBody.slice(0, 300)}`);
  }
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] || character);

