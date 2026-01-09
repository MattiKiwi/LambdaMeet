import { Server } from "http";
import { WebSocketServer, WebSocket, RawData } from "ws";
import { verifyToken } from "./auth.js";
import { env } from "./config.js";
import { getLiveKitConfig, updateLiveKitRoomMetadata } from "./livekit.js";
import { findMeeting } from "./store.js";
import { RoomParticipant } from "./types.js";
import { URL } from "url";
import { actionFailure, actionStart, actionSuccess, withComponent, stepLog } from "./logger.js";

const roomParticipants = new Map<WebSocket, RoomParticipant>();
const participantMap = new Map<string, Map<string, WebSocket>>();
const lobbyMap = new Map<string, Map<string, WebSocket>>();
const lockMap = new Map<string, boolean>();
const log = withComponent("signaling");
const livekitConfig = getLiveKitConfig(env);

export function startSignaling(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", async (socket, req) => {
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
    const meeting = await findMeeting(meetingId);
    if (!meeting) {
      actionFailure("signaling", "connection", { reason: "meeting_not_found", meetingId });
      socket.close(1008, "Meeting not found");
      return;
    }

    const participant = {
      userId: auth.sub,
      meetingId,
      role: auth.role,
      socketId: "" + Date.now() + Math.random(),
      name: auth.fullName || auth.email,
    };
    const policy = meeting.policyJson as { lobbyRequired?: boolean } | null;
    const lobbyRequired = policy?.lobbyRequired ?? true;
    const locked = lockMap.get(meetingId) ?? false;
    const isHost = auth.sub === meeting.hostId || auth.role === "admin";

    if ((locked || lobbyRequired) && !isHost) {
      stepLog("signaling", "connection.lobby", "Client placed in lobby", { meetingId, userId: auth.sub });
      addToLobby(socket, participant);
    } else {
      stepLog("signaling", "connection.accept", "Client joined signaling", { meetingId, userId: auth.sub });
      joinRoom(socket, participant);
    }

    actionSuccess("signaling", "connection", { meetingId, userId: auth.sub });
    socket.on("message", (data) => handleMessage(socket, meetingId, data));
    socket.on("close", () => {
      removeSocket(socket, meetingId);
      stepLog("signaling", "connection.close", "Client disconnected", { meetingId, userId: auth.sub });
    });
  });

  return wss;
}

function joinRoom(socket: WebSocket, participant: RoomParticipant) {
  const room = getParticipantRoom(participant.meetingId);
  room.set(participant.userId, socket);
  roomParticipants.set(socket, participant);
  socket.send(JSON.stringify({ type: "joined", meetingId: participant.meetingId, role: participant.role }));
  log.debug({ step: "room.join", meetingId: participant.meetingId, userId: participant.userId });
  syncRoomMetadata(participant.meetingId);
}

function addToLobby(socket: WebSocket, participant: RoomParticipant) {
  const lobby = getLobbyRoom(participant.meetingId);
  lobby.set(participant.userId, socket);
  roomParticipants.set(socket, participant);
  socket.send(JSON.stringify({ type: "lobby", meetingId: participant.meetingId }));
  log.debug({ step: "room.lobby", meetingId: participant.meetingId, userId: participant.userId });
  syncRoomMetadata(participant.meetingId);
}

function removeSocket(socket: WebSocket, meetingId: string) {
  const participants = participantMap.get(meetingId);
  if (participants) {
    for (const [userId, ws] of participants.entries()) {
      if (ws === socket) {
        participants.delete(userId);
        break;
      }
    }
  }
  const lobby = lobbyMap.get(meetingId);
  if (lobby) {
    for (const [userId, ws] of lobby.entries()) {
      if (ws === socket) {
        lobby.delete(userId);
        break;
      }
    }
  }
  roomParticipants.delete(socket);
  log.debug({ step: "room.leave", meetingId });
  syncRoomMetadata(meetingId);
}

function handleMessage(socket: WebSocket, meetingId: string, data: RawData) {
  actionStart("signaling", "signal.receive", { meetingId });
  const room = participantMap.get(meetingId);
  if (!room) {
    actionFailure("signaling", "signal.receive", { meetingId, reason: "room_missing" });
    return;
  }
  let senderFound = false;
  for (const client of room.values()) {
    if (client === socket) senderFound = true;
    if (client === socket || client.readyState !== WebSocket.OPEN) continue;
    client.send(data);
  }
  if (!senderFound) {
    actionFailure("signaling", "signal.receive", { meetingId, reason: "not_in_room" });
    return;
  }
  log.debug({ step: "signal.fanout", meetingId, bytes: rawDataSize(data) });
  actionSuccess("signaling", "signal.receive", { meetingId });
}

function getParticipantRoom(meetingId: string): Map<string, WebSocket> {
  const existing = participantMap.get(meetingId);
  if (existing) return existing;
  const room = new Map<string, WebSocket>();
  participantMap.set(meetingId, room);
  return room;
}

function getLobbyRoom(meetingId: string): Map<string, WebSocket> {
  const existing = lobbyMap.get(meetingId);
  if (existing) return existing;
  const room = new Map<string, WebSocket>();
  lobbyMap.set(meetingId, room);
  return room;
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

export function listLobby(meetingId: string) {
  const lobby = lobbyMap.get(meetingId);
  if (!lobby) return [];
  return [...lobby.keys()].map((userId) => {
    const participant = roomParticipants.get(lobby.get(userId)!);
    return { userId, role: participant?.role, name: participant?.name };
  });
}

export function listParticipants(meetingId: string) {
  const room = participantMap.get(meetingId);
  if (!room) return [];
  return [...room.keys()].map((userId) => {
    const participant = roomParticipants.get(room.get(userId)!);
    return { userId, role: participant?.role, name: participant?.name };
  });
}

export function setRoomLock(meetingId: string, locked: boolean) {
  lockMap.set(meetingId, locked);
  return locked;
}

export function getRoomSnapshot(meetingId: string) {
  return {
    locked: lockMap.get(meetingId) ?? false,
    lobby: listLobby(meetingId),
    participants: listParticipants(meetingId),
  };
}

export function admitLobbyUser(meetingId: string, userId: string) {
  const lobby = lobbyMap.get(meetingId);
  if (!lobby) return false;
  const socket = lobby.get(userId);
  if (!socket) return false;
  const participant = roomParticipants.get(socket);
  if (!participant) return false;
  lobby.delete(userId);
  joinRoom(socket, participant);
  socket.send(JSON.stringify({ type: "admitted", meetingId }));
  syncRoomMetadata(meetingId);
  return true;
}

export function denyLobbyUser(meetingId: string, userId: string) {
  const lobby = lobbyMap.get(meetingId);
  if (!lobby) return false;
  const socket = lobby.get(userId);
  if (!socket) return false;
  lobby.delete(userId);
  socket.close(4001, "Denied");
  syncRoomMetadata(meetingId);
  return true;
}

export function kickParticipant(meetingId: string, userId: string) {
  const room = participantMap.get(meetingId);
  if (!room) return false;
  const socket = room.get(userId);
  if (!socket) return false;
  room.delete(userId);
  socket.close(4002, "Kicked");
  syncRoomMetadata(meetingId);
  return true;
}

export function muteParticipant(meetingId: string, userId: string, muted: boolean) {
  const room = participantMap.get(meetingId);
  if (!room) return false;
  const socket = room.get(userId);
  if (!socket) return false;
  socket.send(JSON.stringify({ type: "mute", meetingId, muted }));
  return true;
}

async function syncRoomMetadata(meetingId: string) {
  try {
    await updateLiveKitRoomMetadata(livekitConfig, meetingId, getRoomSnapshot(meetingId));
  } catch {
    log.debug({ step: "room.metadata", meetingId }, "LiveKit metadata update failed");
  }
}
