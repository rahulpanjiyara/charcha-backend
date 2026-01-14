import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import router from "./routes/auth.routes.js";
import { initializeSocket } from "./socket/socket.js";

dotenv.config();

const app = express();
const server = http.createServer(app);

// IMPORTANT: Render provides PORT dynamically
const PORT = process.env.PORT || 3000;

/* -------------------- MIDDLEWARES -------------------- */
app.use(
  cors({
    origin: "*", // later restrict to frontend URL
    credentials: true,
  })
);
app.use(express.json());

/* -------------------- ROUTES -------------------- */
app.use("/auth", router);

app.get("/", (_req, res) => {
  res.send("Server is running 🚀");
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
