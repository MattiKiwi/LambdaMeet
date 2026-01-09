import { describe, expect, it } from "vitest";
import { buildRoomMetadata, createLiveKitToken } from "./livekit.js";

describe("createLiveKitToken", () => {
  it("returns a jwt token when config is set", async () => {
    const token = await createLiveKitToken(
      { apiKey: "devkey", apiSecret: "devsecret" },
      "room-1",
      "user-1",
      "Test User"
    );
    expect(String(token).length).toBeGreaterThan(10);
  });

  it("builds room metadata json", () => {
    const metadata = buildRoomMetadata({
      locked: true,
      lobby: [{ userId: "u1", role: "guest" }],
      participants: [{ userId: "u2", role: "user" }],
    });
    expect(metadata).toContain("\"locked\":true");
    expect(metadata).toContain("\"lobbyCount\":1");
    expect(metadata).toContain("\"participantCount\":1");
  });
});
