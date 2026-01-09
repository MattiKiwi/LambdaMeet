import { describe, expect, it } from "vitest";
import { computeStatsSummary, summarizeReport } from "./stats";

describe("summarizeReport", () => {
  it("sums inbound video stats", () => {
    const sample = summarizeReport(
      [
        { type: "inbound-rtp", kind: "video", bytesReceived: 1000, packetsReceived: 90, packetsLost: 10, timestamp: 1000 },
        { type: "inbound-rtp", kind: "video", bytesReceived: 500, packetsReceived: 40, packetsLost: 5, timestamp: 1005 },
      ],
      "inbound",
      "video"
    );
    expect(sample?.bytes).toBe(1500);
    expect(sample?.packetsTotal).toBe(130);
    expect(sample?.packetsLost).toBe(15);
  });
});

describe("computeStatsSummary", () => {
  it("computes bitrate and loss percentage", () => {
    const prev = { bytes: 0, packetsLost: 0, packetsTotal: 0, timestamp: 1000 };
    const next = { bytes: 1000, packetsLost: 10, packetsTotal: 100, timestamp: 2000 };
    const summary = computeStatsSummary(prev, next);
    expect(summary.bitrateKbps).toBe(8);
    expect(summary.packetLossPct).toBe(10);
  });
});
