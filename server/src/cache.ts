import Redis from "ioredis";
import { env } from "./config.js";
import { actionFailure, actionStart, actionSuccess, withComponent } from "./logger.js";

const log = withComponent("cache");
let client: Redis | null = null;

export function initCache() {
  actionStart("cache", "init");
  if (!env.redisUrl) {
    actionSuccess("cache", "init", { skipped: true });
    log.info({ step: "cache.skipped" }, "REDIS_URL not set; cache disabled");
    return null;
  }
  client = new Redis(env.redisUrl);
  client.on("ready", () => {
    actionSuccess("cache", "connect", { url: env.redisUrl });
  });
  client.on("error", (err) => {
    actionFailure("cache", "connect", { error: err.message });
  });
  return client;
}

export async function cacheGet(key: string) {
  if (!client) return null;
  actionStart("cache", "get", { key });
  const value = await client.get(key);
  actionSuccess("cache", "get", { key, hit: value !== null });
  return value;
}

export async function cacheSet(key: string, value: string, ttlSeconds?: number) {
  if (!client) return;
  actionStart("cache", "set", { key, ttlSeconds });
  if (ttlSeconds) {
    await client.set(key, value, "EX", ttlSeconds);
  } else {
    await client.set(key, value);
  }
  actionSuccess("cache", "set", { key });
}

export async function disconnectCache() {
  if (!client) return;
  actionStart("cache", "disconnect");
  await client.quit();
  actionSuccess("cache", "disconnect");
  client = null;
}
