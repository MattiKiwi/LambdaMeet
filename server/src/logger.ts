import fs from "fs";
import path from "path";
import pino from "pino";
import { env } from "./config.js";

const logDir = path.join(process.cwd(), "logs");
fs.mkdirSync(logDir, { recursive: true });

const streams = [
  { stream: process.stdout },
  { stream: pino.destination(path.join(logDir, "app.log")) },
];

export const logger = pino(
  {
    level: env.logLevel,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream(streams)
);

export function withComponent(component: string) {
  return logger.child({ component });
}

export function stepLog(component: string, step: string, message: string, extra?: Record<string, unknown>) {
  withComponent(component).debug({ step, ...extra }, message);
}
