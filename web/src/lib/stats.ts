export type Direction = "inbound" | "outbound";

export type StatsSample = {
  bytes: number;
  packetsLost: number;
  packetsTotal: number;
  timestamp: number;
};

export type StatsSummary = {
  bitrateKbps: number | null;
  packetLossPct: number | null;
};

type StatLike = {
  type: string;
  kind?: string;
  mediaType?: string;
  bytesReceived?: number;
  bytesSent?: number;
  packetsReceived?: number;
  packetsSent?: number;
  packetsLost?: number;
  timestamp?: number;
};

export function summarizeReport(
  report: Iterable<StatLike> | Array<StatLike>,
  direction: Direction,
  kind: "audio" | "video"
): StatsSample | null {
  let bytes = 0;
  let packetsTotal = 0;
  let packetsLost = 0;
  let timestamp = 0;

  for (const stat of report) {
    if (direction === "inbound" && stat.type !== "inbound-rtp") continue;
    if (direction === "outbound" && stat.type !== "outbound-rtp") continue;
    const statKind = stat.kind || stat.mediaType;
    if (statKind !== kind) continue;

    if (direction === "inbound") {
      bytes += stat.bytesReceived ?? 0;
      packetsTotal += stat.packetsReceived ?? 0;
      packetsLost += stat.packetsLost ?? 0;
    } else {
      bytes += stat.bytesSent ?? 0;
      packetsTotal += stat.packetsSent ?? 0;
      packetsLost += stat.packetsLost ?? 0;
    }
    if (stat.timestamp && stat.timestamp > timestamp) {
      timestamp = stat.timestamp;
    }
  }

  if (timestamp === 0) return null;
  return { bytes, packetsLost, packetsTotal, timestamp };
}

export function computeStatsSummary(prev: StatsSample | null, next: StatsSample | null): StatsSummary {
  if (!prev || !next || next.timestamp <= prev.timestamp) {
    return { bitrateKbps: null, packetLossPct: null };
  }

  const deltaBytes = next.bytes - prev.bytes;
  const deltaMs = next.timestamp - prev.timestamp;
  const bitrateKbps = Math.max(0, (deltaBytes * 8) / deltaMs);

  const deltaLost = next.packetsLost - prev.packetsLost;
  const deltaTotal = next.packetsTotal - prev.packetsTotal;
  const packetLossPct = deltaTotal > 0 ? Math.max(0, (deltaLost / deltaTotal) * 100) : 0;

  return {
    bitrateKbps: Math.round(bitrateKbps * 10) / 10,
    packetLossPct: Math.round(packetLossPct * 10) / 10,
  };
}
