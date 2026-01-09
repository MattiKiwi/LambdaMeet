import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { Env } from "./config.js";

export type LiveKitConfig = {
  url?: string;
  apiKey?: string;
  apiSecret?: string;
};

export type LiveKitRoomSnapshot = {
  locked: boolean;
  lobby: { userId: string; role?: string; name?: string | null }[];
  participants: { userId: string; role?: string; name?: string | null }[];
};

export function getLiveKitConfig(env: Env): LiveKitConfig {
  return {
    url: env.livekitUrl,
    apiKey: env.livekitApiKey,
    apiSecret: env.livekitApiSecret,
  };
}

export async function createLiveKitToken(config: LiveKitConfig, room: string, identity: string, name?: string) {
  if (!config.apiKey || !config.apiSecret) {
    throw new Error("LiveKit credentials not configured");
  }
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity,
    name,
    ttl: "2h",
  });
  token.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });
  return token.toJwt();
}

export function buildRoomMetadata(snapshot: LiveKitRoomSnapshot) {
  return JSON.stringify({
    locked: snapshot.locked,
    lobbyCount: snapshot.lobby.length,
    participantCount: snapshot.participants.length,
    lobby: snapshot.lobby,
    participants: snapshot.participants,
  });
}

export async function updateLiveKitRoomMetadata(config: LiveKitConfig, room: string, snapshot: LiveKitRoomSnapshot) {
  if (!config.url || !config.apiKey || !config.apiSecret) {
    return false;
  }
  const client = new RoomServiceClient(config.url, config.apiKey, config.apiSecret);
  await client.updateRoomMetadata(room, buildRoomMetadata(snapshot));
  return true;
}
