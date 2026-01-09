export type IceConfig = {
  iceServers: RTCIceServer[];
};

export type TurnConfig = {
  urls: string[];
  username?: string;
  credential?: string;
} | null;

export type ConnectionBadge = {
  label: string;
  tone: "ok" | "warn" | "bad" | "idle";
};

export function buildIceConfig(turn: TurnConfig): IceConfig {
  if (!turn) {
    return { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  }
  return {
    iceServers: [
      {
        urls: turn.urls,
        username: turn.username,
        credential: turn.credential,
      },
      { urls: "stun:stun.l.google.com:19302" },
    ],
  };
}

export function connectionBadge(state: RTCPeerConnectionState | "idle"): ConnectionBadge {
  switch (state) {
    case "connected":
      return { label: "connected", tone: "ok" };
    case "connecting":
      return { label: "connecting", tone: "warn" };
    case "failed":
      return { label: "failed", tone: "bad" };
    case "disconnected":
      return { label: "disconnected", tone: "warn" };
    case "closed":
      return { label: "closed", tone: "idle" };
    default:
      return { label: "idle", tone: "idle" };
  }
}
