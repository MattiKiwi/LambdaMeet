import { Server } from "http";
import { WebSocketServer, WebSocket, RawData } from "ws";
import { verifyToken } from "./auth.js";
import { RoomParticipant } from "./types.js";
import { URL } from "url";
import { actionFailure, actionStart, actionSuccess, withComponent, stepLog } from "./logger.js";

type RoomMap = Map<string, Set<WebSocket>>;
const roomParticipants = new Map<WebSocket, RoomParticipant>();
const log = withComponent("signaling");

export function startSignaling(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket, req) => {
    actionStart("signaling", "connection", { url: req.url });
    const params = parseQuery(req.url || "");
    const token = params.get("token");
    const meetingId = params.get("meetingId");
    if (!token || !meetingId) {
      actionFailure("signaling", "connection", { reason: "missing_token_or_meeting" });
      socket.close(1008, "Missing token or meeting");
      return;
    }
    const auth = verifyToken(token);
    if (!auth) {
      actionFailure("signaling", "connection", { reason: "invalid_token" });
      socket.close(1008, "Invalid token");
      return;
    }
    const participant = { userId: auth.sub, meetingId, role: auth.role, socketId: "" + Date.now() + Math.random() };
    stepLog("signaling", "connection.accept", "Client joined signaling", { meetingId, userId: auth.sub });
    joinRoom(socket, participant);
    actionSuccess("signaling", "connection", { meetingId, userId: auth.sub });
    socket.on("message", (data) => handleMessage(socket, meetingId, data));
    socket.on("close", () => {
      leaveRoom(socket, meetingId);
      stepLog("signaling", "connection.close", "Client disconnected", { meetingId, userId: auth.sub });
    });
  });

  return wss;
}

function joinRoom(socket: WebSocket, participant: RoomParticipant) {
  const room = getRoom(participant.meetingId);
  room.add(socket);
  roomParticipants.set(socket, participant);
  socket.send(JSON.stringify({ type: "joined", meetingId: participant.meetingId, role: participant.role }));
  log.debug({ step: "room.join", meetingId: participant.meetingId, userId: participant.userId });
}

function leaveRoom(socket: WebSocket, meetingId: string) {
  const room = getRoom(meetingId);
  room.delete(socket);
  roomParticipants.delete(socket);
  log.debug({ step: "room.leave", meetingId });
}

function handleMessage(socket: WebSocket, meetingId: string, data: RawData) {
  actionStart("signaling", "signal.receive", { meetingId });
  const room = getRoomFromCache(meetingId);
  if (!room) {
    actionFailure("signaling", "signal.receive", { meetingId, reason: "room_missing" });
    return;
  }
  for (const client of room) {
    if (client === socket || client.readyState !== WebSocket.OPEN) continue;
    client.send(data);
  }
  log.debug({ step: "signal.fanout", meetingId, bytes: rawDataSize(data) });
  actionSuccess("signaling", "signal.receive", { meetingId });
}

function getRoom(meetingId: string): Set<WebSocket> {
  const existing = roomCache.get(meetingId);
  if (existing) return existing;
  const room = new Set<WebSocket>();
  roomCache.set(meetingId, room);
  return room;
}

const roomCache: RoomMap = new Map();

function getRoomFromCache(meetingId: string): Set<WebSocket> | undefined {
  return roomCache.get(meetingId);
}

function parseQuery(url: string): URLSearchParams {
  try {
    const parsed = new URL(url, "http://localhost");
    return parsed.searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function rawDataSize(data: RawData): number {
  const anyData = data as unknown;
  if (typeof anyData === "string") {
    return (anyData as string).length;
  }
  if (Buffer.isBuffer(anyData)) {
    return (anyData as Buffer).byteLength;
  }
  if (Array.isArray(anyData)) {
    return (anyData as Buffer[]).reduce((acc, buf) => acc + (Buffer.isBuffer(buf) ? buf.byteLength : 0), 0);
  }
  if (anyData instanceof ArrayBuffer) {
    return anyData.byteLength;
  }
  return 0;
}
