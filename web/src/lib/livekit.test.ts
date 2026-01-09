import { describe, expect, it } from "vitest";
import { normalizeLiveKitUrl } from "./livekit";

describe("normalizeLiveKitUrl", () => {
  it("converts http to ws", () => {
    expect(normalizeLiveKitUrl("http://localhost:7880")).toBe("ws://localhost:7880");
  });

  it("converts https to wss", () => {
    expect(normalizeLiveKitUrl("https://example.com")).toBe("wss://example.com");
  });

  it("leaves ws urls intact", () => {
    expect(normalizeLiveKitUrl("ws://localhost:7880")).toBe("ws://localhost:7880");
  });
});
