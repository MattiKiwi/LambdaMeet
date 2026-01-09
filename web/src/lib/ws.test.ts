import { describe, expect, it } from "vitest";
import { buildWsUrl } from "./ws";

describe("buildWsUrl", () => {
  it("builds ws url with token and meeting", () => {
    const url = buildWsUrl("http://localhost:4000", "token123", "meeting456");
    expect(url).toBe("ws://localhost:4000/ws?token=token123&meetingId=meeting456");
  });
});
