import { AccessToken } from "livekit-server-sdk";
import { Env } from "./config.js";

export type LiveKitConfig = {
  url?: string;
  apiKey?: string;
  apiSecret?: string;
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
