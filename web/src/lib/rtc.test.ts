import { describe, expect, it } from "vitest";
import { buildIceConfig, connectionBadge } from "./rtc";

describe("buildIceConfig", () => {
  it("includes default STUN when no TURN", () => {
    const config = buildIceConfig(null);
    expect(config.iceServers[0].urls).toBe("stun:stun.l.google.com:19302");
  });

  it("includes TURN creds when provided", () => {
    const config = buildIceConfig({
      urls: ["turn:localhost:3478"],
      username: "u",
      credential: "p",
    });
    expect(config.iceServers[0].urls).toEqual(["turn:localhost:3478"]);
    expect(config.iceServers[0].username).toBe("u");
    expect(config.iceServers[0].credential).toBe("p");
  });
});

describe("connectionBadge", () => {
  it("returns expected tone for connected", () => {
    const badge = connectionBadge("connected");
    expect(badge.tone).toBe("ok");
    expect(badge.label).toBe("connected");
  });

  it("returns expected tone for failed", () => {
    const badge = connectionBadge("failed");
    expect(badge.tone).toBe("bad");
    expect(badge.label).toBe("failed");
  });
});
