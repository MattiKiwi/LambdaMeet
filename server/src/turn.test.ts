import { describe, expect, it } from "vitest";
import { getTurnConfig } from "./turn.js";

describe("getTurnConfig", () => {
  it("returns null when TURN_URL missing", () => {
    const config = getTurnConfig({
      port: 0,
      host: "0.0.0.0",
      jwtSecret: "x",
      devAuthEnabled: true,
      corsOrigin: undefined,
      logLevel: "info",
      redisUrl: undefined,
      turnUrl: undefined,
      turnUsername: undefined,
      turnPassword: undefined,
    });
    expect(config).toBeNull();
  });

  it("returns config when TURN_URL present", () => {
    const config = getTurnConfig({
      port: 0,
      host: "0.0.0.0",
      jwtSecret: "x",
      devAuthEnabled: true,
      corsOrigin: undefined,
      logLevel: "info",
      redisUrl: undefined,
      turnUrl: "turn:localhost:3478",
      turnUsername: "user",
      turnPassword: "pass",
    });
    expect(config?.urls[0]).toBe("turn:localhost:3478");
    expect(config?.username).toBe("user");
    expect(config?.credential).toBe("pass");
  });
});
