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
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use('/auth',router)

app.get("/", (req, res) => {
  res.send("Server is running Dear");
});
//listen to socket connections
initializeSocket(server);

connectDB().then(() => {
  server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
}).catch((error) => {
  console.log("Failed to start server due to database connection error: ", error);
  
});

