import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import connectDB from "./config/db.js";
import router from "./routes/auth.routes.js";
import { initializeSocket } from "./socket/socket.js";

dotenv.config();

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim())
  : "*";

/* -------------------- MIDDLEWARES -------------------- */
app.use(
  cors({
    origin: allowedOrigins,
  })
);
app.use(express.json());

/* -------------------- ROUTES -------------------- */
app.use("/auth", router);

app.get("/", (_req, res) => {
  res.send("Server is running 🚀");
});

app.get("/account-deletion", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Delete your Charcha account</title>
    <style>
      :root { color-scheme: light; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; background: #f6f5ff; color: #211a3b; }
      main { box-sizing: border-box; width: min(720px, calc(100% - 32px)); margin: 48px auto; padding: 32px; background: #fff; border: 1px solid #e4e0f5; border-radius: 20px; box-shadow: 0 16px 50px rgba(48, 35, 99, .09); }
      h1 { margin: 0 0 12px; color: #4b32a8; font-size: clamp(28px, 5vw, 40px); }
      h2 { margin-top: 28px; font-size: 20px; }
      p, li { line-height: 1.65; }
      a.button { display: inline-block; margin-top: 8px; padding: 12px 18px; border-radius: 10px; background: #5b3fc4; color: #fff; font-weight: 700; text-decoration: none; }
      .note { padding: 14px 16px; border-radius: 12px; background: #f1effb; }
    </style>
  </head>
  <body>
    <main>
      <h1>Delete your Charcha account</h1>
      <p>You can request permanent deletion of your Charcha account and its associated data at any time.</p>

      <h2>How to request deletion</h2>
      <ol>
        <li>Email us from the address registered with your Charcha account.</li>
        <li>Use the subject <strong>Charcha account deletion request</strong>.</li>
        <li>Include your profile name so we can identify and verify the account.</li>
      </ol>
      <a class="button" href="mailto:rahulpanjiyara@gmail.com?subject=Charcha%20account%20deletion%20request">Request account deletion</a>

      <h2>What will be deleted</h2>
      <p>After verification, we delete your account details, profile information, friend connections, posts, comments, reactions, uploaded media, conversations, messages, call records and notification tokens from Charcha's active systems.</p>

      <h2>Retention</h2>
      <p class="note">The request is normally completed within 30 days. Limited records may be retained only when required for security, fraud prevention, legal compliance or disaster-recovery backups. Backup copies are removed through the normal backup cycle and are not used for any other purpose.</p>

      <p>Need help? Contact <a href="mailto:rahulpanjiyara@gmail.com">rahulpanjiyara@gmail.com</a>.</p>
    </main>
  </body>
</html>`);
});

app.get("/child-safety-standards", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Charcha child safety standards</title>
    <style>
      :root { color-scheme: light; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; background: #f6f5ff; color: #211a3b; }
      main { box-sizing: border-box; width: min(760px, calc(100% - 32px)); margin: 48px auto; padding: 32px; background: #fff; border: 1px solid #e4e0f5; border-radius: 20px; box-shadow: 0 16px 50px rgba(48, 35, 99, .09); }
      h1 { margin: 0 0 12px; color: #4b32a8; font-size: clamp(28px, 5vw, 40px); }
      h2 { margin-top: 28px; font-size: 20px; }
      p, li { line-height: 1.65; }
      a.button { display: inline-block; margin-top: 8px; padding: 12px 18px; border-radius: 10px; background: #5b3fc4; color: #fff; font-weight: 700; text-decoration: none; }
      .note { padding: 14px 16px; border-radius: 12px; background: #f1effb; }
    </style>
  </head>
  <body>
    <main>
      <h1>Charcha child safety standards</h1>
      <p><strong>Last updated: 4 August 2026</strong></p>
      <p>Charcha has zero tolerance for child sexual abuse and exploitation (CSAE) or child sexual abuse material (CSAM). These standards apply to every user, post, profile, message, photo and other interaction on Charcha.</p>

      <h2>Prohibited content and conduct</h2>
      <ul>
        <li>Creating, uploading, sharing, requesting, promoting or storing CSAM is prohibited.</li>
        <li>Grooming, sexual solicitation of minors, sextortion, trafficking, or any attempt to exploit a child is prohibited.</li>
        <li>Content that sexualises, endangers, identifies for abuse, or facilitates inappropriate contact with a minor is prohibited.</li>
      </ul>

      <h2>Reporting a concern</h2>
      <p>Users can open a conversation's menu in Charcha and choose <strong>Report safety concern</strong>. Reports may also be sent directly to our designated child-safety contact.</p>
      <a class="button" href="mailto:rahulpanjiyara@gmail.com?subject=Charcha%20child%20safety%20report">Report a child-safety concern</a>
      <p class="note">If a child is in immediate danger, contact local emergency services or the appropriate national child-protection authority first.</p>

      <h2>How Charcha responds</h2>
      <p>We review child-safety reports promptly. When we identify prohibited content or conduct, we may remove content, restrict or terminate accounts, preserve relevant records where legally permitted, and report apparent CSAM or child exploitation to the appropriate regional or national authorities.</p>

      <h2>Compliance and cooperation</h2>
      <p>Charcha complies with applicable child-safety laws and cooperates with lawful requests from authorised agencies. We continually review our practices and product controls to reduce risks to children.</p>

      <h2>Designated contact</h2>
      <p>For questions about Charcha's CSAM prevention practices or compliance, contact <a href="mailto:rahulpanjiyara@gmail.com">rahulpanjiyara@gmail.com</a>.</p>
    </main>
  </body>
</html>`);
});

app.get("/health", (_req, res) => {
  const databaseConnected = mongoose.connection.readyState === 1;

  res.status(databaseConnected ? 200 : 503).json({
    status: databaseConnected ? "ok" : "unavailable",
    database: databaseConnected ? "connected" : "disconnected",
  });
});

app.get("/app-version", (_req, res) => {
  const latestVersionCode = Math.max(1, Number.parseInt(process.env.ANDROID_LATEST_VERSION_CODE || "3", 10) || 3);
  const minimumVersionCode = Math.max(1, Number.parseInt(process.env.ANDROID_MIN_VERSION_CODE || String(latestVersionCode), 10) || latestVersionCode);

  res.json({
    android: {
      latestVersionCode,
      minimumVersionCode,
      storeUrl: "https://play.google.com/store/apps/details?id=com.rahulpanjiyara.charcha",
    },
  });
});

/* -------------------- SOCKET.IO -------------------- */
initializeSocket(server);

/* -------------------- START SERVER -------------------- */
connectDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error(
      "❌ Failed to start server due to DB connection error:",
      error
    );
    process.exit(1);
  });
