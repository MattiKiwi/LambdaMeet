import dotenv from "dotenv";

dotenv.config();

export type Env = {
  port: number;
  host: string;
  jwtSecret: string;
  devAuthEnabled: boolean;
  corsOrigin: string | undefined;
  logLevel: string;
  redisUrl?: string;
  turnUrl?: string;
  turnUsername?: string;
  turnPassword?: string;
};

export const env: Env = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || "0.0.0.0",
  jwtSecret: process.env.JWT_SECRET || "replace-me-dev-secret",
  devAuthEnabled: process.env.DEV_AUTH_ENABLED !== "false",
  corsOrigin: process.env.CORS_ORIGIN,
  logLevel: process.env.LOG_LEVEL || "info",
  redisUrl: process.env.REDIS_URL,
  turnUrl: process.env.TURN_URL,
  turnUsername: process.env.TURN_USERNAME,
  turnPassword: process.env.TURN_PASSWORD,
};
