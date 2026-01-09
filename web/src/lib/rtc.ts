export type IceConfig = {
  iceServers: RTCIceServer[];
};

export type TurnConfig = {
  urls: string[];
  username?: string;
  credential?: string;
} | null;

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
