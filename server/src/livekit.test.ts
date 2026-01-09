import { describe, expect, it } from "vitest";
import { createLiveKitToken } from "./livekit.js";

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
});
