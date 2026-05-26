import { SignalingServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "4444", 10);
const server = new SignalingServer(PORT);
server.start();
