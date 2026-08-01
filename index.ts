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

app.get("/health", (_req, res) => {
  const databaseConnected = mongoose.connection.readyState === 1;

  res.status(databaseConnected ? 200 : 503).json({
    status: databaseConnected ? "ok" : "unavailable",
    database: databaseConnected ? "connected" : "disconnected",
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
