import { Env } from "./config.js";

export type TurnConfig = {
  urls: string[];
  username?: string;
  credential?: string;
};

export function getTurnConfig(env: Env): TurnConfig | null {
  if (!env.turnUrl) return null;
  const config: TurnConfig = {
    urls: [env.turnUrl],
  };
  if (env.turnUsername && env.turnPassword) {
    config.username = env.turnUsername;
    config.credential = env.turnPassword;
  }
  return config;
}
