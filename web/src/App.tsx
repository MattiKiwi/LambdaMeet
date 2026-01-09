import type { FormEvent, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  VideoQuality,
  createLocalTracks,
} from "livekit-client";
import { computeBackoffMs } from "./lib/backoff";
import { normalizeLiveKitUrl } from "./lib/livekit";
import { buildIceConfig, connectionBadge, type TurnConfig } from "./lib/rtc";
import { computeStatsSummary, summarizeReport, type StatsSample, type StatsSummary } from "./lib/stats";
import { buildWsUrl } from "./lib/ws";
import "./App.css";

type Meeting = {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  policy: { lobbyRequired: boolean };
};

type User = { id: string; email: string; role: string };
type SignalMessage =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit }
  | { type: "mute"; muted: boolean }
  | { type: "lobby" }
  | { type: "admitted" };
type LiveKitTrackItem = {
  id: string;
  kind: "video" | "audio";
  track: RemoteTrack;
  publication: RemoteTrackPublication;
  participantIdentity: string;
  participantName?: string;
};
type RoomSnapshot = {
  locked: boolean;
  lobby: { userId: string; role?: string }[];
  participants: { userId: string; role?: string }[];
};

const DEFAULT_API = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

function App() {
  const [apiBase, setApiBase] = useState(DEFAULT_API);
  const [token, setToken] = useState<string>("");
  const [user, setUser] = useState<User | null>(null);
  const [loginForm, setLoginForm] = useState({ email: "", password: "", role: "user" });
  const [meetingForm, setMeetingForm] = useState({
    title: "Weekly Sync",
    startTime: new Date().toISOString(),
    endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    lobbyRequired: true,
  });
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [turnConfig, setTurnConfig] = useState<TurnConfig>(null);
  const [livekitUrl, setLivekitUrl] = useState<string | null>(null);
  const [livekitError, setLivekitError] = useState<string>("");
  const [livekitRoom, setLivekitRoom] = useState<Room | null>(null);
  const [livekitStatus, setLivekitStatus] = useState("disconnected");
  const [livekitTracks, setLivekitTracks] = useState<LiveKitTrackItem[]>([]);
  const [livekitParticipantCount, setLivekitParticipantCount] = useState(0);
  const [livekitStats, setLivekitStats] = useState<Record<string, StatsSummary>>({});
  const [livekitLocalStats, setLivekitLocalStats] = useState<StatsSummary | null>(null);
  const [livekitLocalAudioStats, setLivekitLocalAudioStats] = useState<StatsSummary | null>(null);
  const [livekitQuality, setLivekitQuality] = useState<VideoQuality>(VideoQuality.HIGH);
  const [livekitRoomState, setLivekitRoomState] = useState<string>("disconnected");
  const [livekitQualityPrefs, setLivekitQualityPrefs] = useState<Record<string, VideoQuality>>({});
  const [livekitReconnects, setLivekitReconnects] = useState(0);
  const [livekitSignalState, setLivekitSignalState] = useState("idle");
  const [livekitSubscriptions, setLivekitSubscriptions] = useState<Record<string, boolean>>({});
  const [livekitAudioMuted, setLivekitAudioMuted] = useState<Record<string, boolean>>({});
  const [muteAllRemoteAudio, setMuteAllRemoteAudio] = useState(false);
  const [roomSnapshot, setRoomSnapshot] = useState<RoomSnapshot | null>(null);
  const [roomMuteState, setRoomMuteState] = useState<Record<string, boolean>>({});
  const [inviteMeetingId, setInviteMeetingId] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("guest");
  const [inviteResult, setInviteResult] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [meetingToJoin, setMeetingToJoin] = useState("");
  const [wsStatus, setWsStatus] = useState("disconnected");
  const [wsMessages, setWsMessages] = useState<string[]>([]);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const [deviceError, setDeviceError] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [previewActive, setPreviewActive] = useState(false);
  const [callActive, setCallActive] = useState(false);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState | "idle">("idle");
  const [iceState, setIceState] = useState<RTCIceConnectionState | "idle">("idle");
  const livekitStatsTimerRef = useRef<number | null>(null);
  const livekitLocalTrackRef = useRef<LocalVideoTrack | null>(null);
  const livekitLocalPrevRef = useRef<StatsSample | null>(null);
  const livekitLocalAudioRef = useRef<LocalAudioTrack | null>(null);
  const livekitLocalAudioPrevRef = useRef<StatsSample | null>(null);
  const livekitRemotePrevRef = useRef<Map<string, StatsSample>>(new Map());

  const api = useMemo(() => apiClient(apiBase, token), [apiBase, token]);

  useEffect(() => {
    if (!token) return;
    loadMeetings();
  }, [token]);

  useEffect(() => {
    loadConfig();
  }, [apiBase]);

  async function loadMeetings() {
    const res = await api.get("/meetings");
    if (res.ok) {
      setMeetings(res.data.meetings);
    }
  }

  async function loadConfig() {
    const res = await api.get("/config");
    if (res.ok) {
      setTurnConfig(res.data.turn);
      const rawUrl = res.data.livekit?.url ?? null;
      setLivekitUrl(rawUrl ? normalizeLiveKitUrl(rawUrl) : null);
    }
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setStatus("Signing in...");
    const res = await api.post("/auth/login", {
      email: loginForm.email,
      password: loginForm.password || undefined,
      role: loginForm.role,
    });
    if (!res.ok) {
      setStatus("Login failed");
      return;
    }
    setStatus("Authenticated");
    setToken(res.data.token);
    setUser(res.data.user);
  }

  async function handleCreateMeeting(e: FormEvent) {
    e.preventDefault();
    const res = await api.post("/meetings", {
      title: meetingForm.title,
      startTime: meetingForm.startTime,
      endTime: meetingForm.endTime,
      policy: { lobbyRequired: meetingForm.lobbyRequired },
    });
    if (!res.ok) {
      setStatus("Failed to create meeting");
      return;
    }
    setStatus("Meeting created");
    setMeetings((prev) => [...prev, res.data.meeting]);
  }

  async function handleCreateInvite(e: FormEvent) {
    e.preventDefault();
    if (!inviteMeetingId) return;
    const res = await api.post(`/meetings/${inviteMeetingId}/invites`, {
      email: inviteEmail || undefined,
      role: inviteRole,
    });
    if (!res.ok) {
      setInviteResult("Failed to create invite");
      return;
    }
    setInviteResult(JSON.stringify(res.data.invite, null, 2));
  }

  function connectSignaling(e?: FormEvent) {
    e?.preventDefault();
    if (!token || !meetingToJoin) {
      setWsStatus("token or meeting missing");
      return;
    }
    if (wsRef.current) {
      wsRef.current.close();
    }
    const wsUrl = buildWsUrl(apiBase, token, meetingToJoin);
    const socket = new WebSocket(wsUrl);
    wsRef.current = socket;
    setWsStatus("connecting");
    socket.onopen = () => {
      setWsStatus("connected");
      setReconnectAttempts(0);
      clearReconnectTimer();
    };
    socket.onclose = () => {
      setWsStatus("disconnected");
      scheduleReconnect();
    };
    socket.onerror = () => setWsStatus("error");
    socket.onmessage = (evt) => {
      const payload = String(evt.data);
      setWsMessages((prev) => [payload, ...prev].slice(0, 10));
      handleSignal(payload);
    };
  }

  function disconnectSocket() {
    wsRef.current?.close();
    wsRef.current = null;
    clearReconnectTimer();
    setReconnectAttempts(0);
  }

  function sendSignal(message: string) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(message);
  }

  function clearReconnectTimer() {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }

  function scheduleReconnect() {
    if (!autoReconnect || !token || !meetingToJoin) return;
    clearReconnectTimer();
    const nextAttempt = reconnectAttempts + 1;
    const delay = computeBackoffMs(nextAttempt, { baseMs: 500, maxMs: 8000 });
    reconnectTimerRef.current = window.setTimeout(() => {
      setReconnectAttempts(nextAttempt);
      connectSignaling();
    }, delay);
  }

  function ensurePeerConnection() {
    if (pcRef.current) return pcRef.current;
    const pc = new RTCPeerConnection(buildIceConfig(turnConfig));
    pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        sendSignal(JSON.stringify({ type: "ice", candidate: evt.candidate } satisfies SignalMessage));
      }
    };
    pc.ontrack = (evt) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = evt.streams[0];
      }
    };
    pc.onconnectionstatechange = () => {
      setConnectionState(pc.connectionState);
    };
    pc.oniceconnectionstatechange = () => {
      setIceState(pc.iceConnectionState);
      if (pc.iceConnectionState === "failed") {
        restartIce();
      }
    };
    pcRef.current = pc;
    return pc;
  }

  async function startCall() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setStatus("Connect signaling first");
      return;
    }
    const pc = ensurePeerConnection();
    let stream = videoRef.current?.srcObject as MediaStream | null;
    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setPreviewActive(true);
    }
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(JSON.stringify({ type: "offer", sdp: offer.sdp || "" } satisfies SignalMessage));
    setCallActive(true);
  }

  async function endCall() {
    pcRef.current?.close();
    pcRef.current = null;
    setConnectionState("closed");
    setIceState("closed");
    if (remoteVideoRef.current?.srcObject) {
      const stream = remoteVideoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      remoteVideoRef.current.srcObject = null;
    }
    setCallActive(false);
  }

  async function handleSignal(payload: string) {
    let message: SignalMessage | null = null;
    try {
      message = JSON.parse(payload) as SignalMessage;
    } catch {
      return;
    }
    if (message.type === "lobby") {
      setStatus("Waiting in lobby");
      return;
    }
    if (message.type === "admitted") {
      setStatus("Admitted to meeting");
      return;
    }
    if (message.type === "mute") {
      const muted = message.muted;
      const stream = videoRef.current?.srcObject as MediaStream | null;
      if (stream) {
        stream.getAudioTracks().forEach((track) => {
          track.enabled = !muted;
        });
      }
      setStatus(muted ? "Muted by host" : "Unmuted");
      return;
    }
    const pc = ensurePeerConnection();
    if (message.type === "offer") {
      await pc.setRemoteDescription({ type: "offer", sdp: message.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(JSON.stringify({ type: "answer", sdp: answer.sdp || "" } satisfies SignalMessage));
      setCallActive(true);
      return;
    }
    if (message.type === "answer") {
      await pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
      setCallActive(true);
      return;
    }
    if (message.type === "ice") {
      await pc.addIceCandidate(message.candidate);
    }
  }

  async function restartIce() {
    if (!pcRef.current) return;
    const offer = await pcRef.current.createOffer({ iceRestart: true });
    await pcRef.current.setLocalDescription(offer);
    sendSignal(JSON.stringify({ type: "offer", sdp: offer.sdp || "" } satisfies SignalMessage));
  }

  async function joinLiveKit() {
    setLivekitError("");
    if (!token || !meetingToJoin) {
      setStatus("Authenticate and set meeting id first");
      return;
    }
    if (!livekitUrl) {
      setStatus("LiveKit URL not configured");
      return;
    }
    try {
      const res = await api.post("/livekit/token", { room: meetingToJoin });
      if (!res.ok) {
        setStatus("Failed to get LiveKit token");
        return;
      }
      const rawToken = res.data?.token as unknown;
      const livekitToken =
        typeof rawToken === "string"
          ? rawToken
          : typeof (rawToken as { token?: string })?.token === "string"
          ? (rawToken as { token: string }).token
          : null;
      if (!livekitToken) {
        setLivekitStatus("disconnected");
        setLivekitError("LiveKit token missing or invalid");
        return;
      }
      const room = new Room();
      const updateParticipants = () => {
        setLivekitParticipantCount(1 + room.remoteParticipants.size);
      };
      room.on(RoomEvent.ParticipantConnected, updateParticipants);
      room.on(RoomEvent.ParticipantDisconnected, updateParticipants);
      room.on(RoomEvent.ConnectionStateChanged, (state) => {
        setLivekitRoomState(state);
      });
      room.on(RoomEvent.SignalReconnecting, () => {
        setLivekitSignalState("signal reconnecting");
      });
      room.on(RoomEvent.Reconnecting, () => {
        setLivekitSignalState("media reconnecting");
        setLivekitReconnects((prev) => prev + 1);
      });
      room.on(RoomEvent.Reconnected, () => {
        setLivekitSignalState("connected");
      });
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        const id = publication.trackSid || track.sid;
        if (!id) return;
        setLivekitTracks((prev) => {
          if (prev.some((item) => item.id === id)) return prev;
          if (track.kind !== "video" && track.kind !== "audio") return prev;
          return [
            ...prev,
            {
              id,
              kind: track.kind,
              track,
              publication,
              participantIdentity: participant.identity,
              participantName: participant.name,
            },
          ];
        });
        setLivekitSubscriptions((prev) => ({ ...prev, [id]: true }));
        if (track.kind === "audio" && muteAllRemoteAudio) {
          setLivekitAudioMuted((prev) => ({ ...prev, [id]: true }));
        }
      });
      room.on(RoomEvent.TrackUnsubscribed, (_track: RemoteTrack, publication: RemoteTrackPublication) => {
        const id = publication.trackSid;
        if (!id) return;
        setLivekitTracks((prev) => prev.filter((item) => item.id !== id));
        setLivekitQualityPrefs((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setLivekitSubscriptions((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setLivekitAudioMuted((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      });
      room.on(RoomEvent.Disconnected, () => {
        setLivekitStatus("disconnected");
        setLivekitTracks([]);
        setLivekitParticipantCount(0);
        setLivekitRoomState("disconnected");
      });
      setLivekitStatus("connecting");
      await room.connect(livekitUrl, livekitToken);
      const tracks = await createLocalTracks({ audio: true, video: true });
      tracks.forEach((track) => {
        room.localParticipant.publishTrack(track);
        if (track.kind === "video" && track instanceof LocalVideoTrack) {
          livekitLocalTrackRef.current = track;
        }
        if (track.kind === "audio" && track instanceof LocalAudioTrack) {
          livekitLocalAudioRef.current = track;
        }
      });
      setLivekitRoom(room);
      setLivekitStatus("connected");
      startLiveKitStatsPolling();
      updateParticipants();
    } catch (err) {
      setLivekitStatus("disconnected");
      const message = (err as Error).message || "LiveKit connect failed";
      setLivekitError(message);
      setStatus(message);
    }
  }

  async function leaveLiveKit() {
    if (livekitRoom) {
      livekitRoom.localParticipant.trackPublications.forEach((pub) => pub.track?.stop());
      livekitRoom.removeAllListeners();
      livekitRoom.disconnect();
      setLivekitRoom(null);
    }
    setLivekitStatus("disconnected");
    setLivekitTracks([]);
    setLivekitParticipantCount(0);
    setLivekitStats({});
    setLivekitLocalStats(null);
    setLivekitLocalAudioStats(null);
    setLivekitQualityPrefs({});
    setLivekitRoomState("disconnected");
    setLivekitReconnects(0);
    setLivekitSignalState("idle");
    setLivekitSubscriptions({});
    setLivekitAudioMuted({});
    setMuteAllRemoteAudio(false);
    livekitLocalPrevRef.current = null;
    livekitLocalAudioPrevRef.current = null;
    livekitRemotePrevRef.current = new Map();
    if (livekitStatsTimerRef.current) {
      window.clearInterval(livekitStatsTimerRef.current);
      livekitStatsTimerRef.current = null;
    }
  }

  function startLiveKitStatsPolling() {
    if (livekitStatsTimerRef.current) {
      window.clearInterval(livekitStatsTimerRef.current);
    }
    livekitStatsTimerRef.current = window.setInterval(async () => {
      const localTrack = livekitLocalTrackRef.current;
      if (localTrack) {
        const report = await localTrack.getRTCStatsReport();
        if (report) {
          const sample = summarizeReport(report.values(), "outbound", "video");
          const summary = computeStatsSummary(livekitLocalPrevRef.current, sample);
          if (sample) livekitLocalPrevRef.current = sample;
          if (summary.bitrateKbps !== null) {
            setLivekitLocalStats(summary);
            adjustLiveKitQuality(summary);
          }
        }
      }

      const localAudio = livekitLocalAudioRef.current;
      if (localAudio) {
        const report = await localAudio.getRTCStatsReport();
        if (report) {
          const sample = summarizeReport(report.values(), "outbound", "audio");
          const summary = computeStatsSummary(livekitLocalAudioPrevRef.current, sample);
          if (sample) livekitLocalAudioPrevRef.current = sample;
          if (summary.bitrateKbps !== null) {
            setLivekitLocalAudioStats(summary);
          }
        }
      }

      const nextStats: Record<string, StatsSummary> = {};
      for (const item of livekitTracks) {
        const report = await item.track.getRTCStatsReport?.();
        if (!report) continue;
        const prev = livekitRemotePrevRef.current.get(item.id) || null;
        const sample = summarizeReport(report.values(), "inbound", item.kind);
        const summary = computeStatsSummary(prev, sample);
        if (sample) livekitRemotePrevRef.current.set(item.id, sample);
        nextStats[item.id] = summary;
      }
      if (Object.keys(nextStats).length) {
        setLivekitStats(nextStats);
      }
    }, 2000);
  }

  function adjustLiveKitQuality(summary: StatsSummary) {
    if (summary.bitrateKbps === null || summary.packetLossPct === null) return;
    let nextQuality = VideoQuality.HIGH;
    if (summary.packetLossPct > 5 || summary.bitrateKbps < 300) {
      nextQuality = VideoQuality.LOW;
    } else if (summary.bitrateKbps < 800) {
      nextQuality = VideoQuality.MEDIUM;
    }
    if (nextQuality === livekitQuality) return;
    livekitLocalTrackRef.current?.setPublishingQuality(nextQuality);
    setLivekitQuality(nextQuality);
  }

  function updateRemoteQuality(item: LiveKitTrackItem, quality: VideoQuality) {
    item.publication.setVideoQuality(quality);
    setLivekitQualityPrefs((prev) => ({ ...prev, [item.id]: quality }));
  }

  function toggleSubscription(item: LiveKitTrackItem) {
    const current = livekitSubscriptions[item.id] ?? true;
    item.publication.setSubscribed(!current);
    setLivekitSubscriptions((prev) => ({ ...prev, [item.id]: !current }));
  }

  function toggleAudioMute(item: LiveKitTrackItem) {
    const current = livekitAudioMuted[item.id] ?? false;
    const next = !current;
    setLivekitAudioMuted((prev) => ({ ...prev, [item.id]: next }));
    if (!next) {
      setMuteAllRemoteAudio(false);
    }
  }

  function toggleMuteAllRemoteAudio() {
    const next = !muteAllRemoteAudio;
    setMuteAllRemoteAudio(next);
    setLivekitAudioMuted((prev) => {
      const updated = { ...prev };
      for (const item of livekitTracks) {
        if (item.kind === "audio") {
          updated[item.id] = next;
        }
      }
      return updated;
    });
  }

  async function loadRoomState() {
    if (!meetingToJoin || !token) return;
    const res = await api.get(`/meetings/${meetingToJoin}/state`);
    if (!res.ok) {
      setStatus("Failed to load room state");
      return;
    }
    setRoomSnapshot(res.data);
  }

  async function toggleRoomLock() {
    if (!meetingToJoin || !roomSnapshot) return;
    const res = await api.post(`/meetings/${meetingToJoin}/lock`, { locked: !roomSnapshot.locked });
    if (!res.ok) {
      setStatus("Failed to lock room");
      return;
    }
    setRoomSnapshot({ ...roomSnapshot, locked: res.data.locked });
  }

  async function admitUser(userId: string) {
    if (!meetingToJoin) return;
    const res = await api.post(`/meetings/${meetingToJoin}/admit`, { userId });
    if (!res.ok) {
      setStatus("Failed to admit");
      return;
    }
    loadRoomState();
  }

  async function denyUser(userId: string) {
    if (!meetingToJoin) return;
    const res = await api.post(`/meetings/${meetingToJoin}/deny`, { userId });
    if (!res.ok) {
      setStatus("Failed to deny");
      return;
    }
    loadRoomState();
  }

  async function kickUser(userId: string) {
    if (!meetingToJoin) return;
    const res = await api.post(`/meetings/${meetingToJoin}/kick`, { userId });
    if (!res.ok) {
      setStatus("Failed to kick");
      return;
    }
    loadRoomState();
  }

  async function muteUser(userId: string) {
    if (!meetingToJoin) return;
    const muted = !(roomMuteState[userId] ?? false);
    const res = await api.post(`/meetings/${meetingToJoin}/mute`, { userId, muted });
    if (!res.ok) {
      setStatus("Failed to mute");
      return;
    }
    setRoomMuteState((prev) => ({ ...prev, [userId]: muted }));
  }

  async function listDevices() {
    setDeviceError("");
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list);
    } catch (err) {
      setDeviceError((err as Error).message || "Failed to list devices");
    }
  }

  async function startPreview() {
    setDeviceError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setPreviewActive(true);
      await listDevices();
    } catch (err) {
      setDeviceError((err as Error).message || "Failed to start preview");
    }
  }

  function stopPreview() {
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
    setPreviewActive(false);
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">LambdaMeet / WebRTC</p>
          <h1>Secure video stack scaffold</h1>
          <p className="lede">
            Signaling + scheduling baseline. Authenticate, schedule, invite guests, and open a WebSocket for ICE/SDP exchange.
          </p>
        </div>
        <div className="status-card">
          <div>
            <span className="label">API base</span>
            <code>{apiBase}</code>
          </div>
          <div>
            <span className="label">Auth</span>
            <strong>{user ? `${user.email} (${user.role})` : "not signed in"}</strong>
          </div>
          <div>
            <span className="label">WebSocket</span>
            <strong>{wsStatus}</strong>
          </div>
        </div>
      </header>

      <main className="grid">
        <section className="card">
          <h2>Environment</h2>
          <label className="field">
            <span>API base URL</span>
            <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
          </label>
          <p className="hint">Defaults to http://localhost:4000 (DEV_AUTH_ENABLED on backend for passwordless login).</p>
        </section>

        <section className="card">
          <h2>WebRTC preflight</h2>
          <div className="stack">
            <div className="row">
              <button type="button" onClick={startPreview}>
                Start preview
              </button>
              <button type="button" onClick={stopPreview} disabled={!previewActive}>
                Stop preview
              </button>
              <button type="button" onClick={listDevices}>
                Refresh devices
              </button>
            </div>
            {deviceError ? <p className="status error">{deviceError}</p> : null}
            <video ref={videoRef} autoPlay muted playsInline className="preview" />
            <div className="list">
              {devices.map((device) => (
                <div key={device.deviceId} className="list-item">
                  <div>
                    <strong>{device.label || device.kind}</strong>
                    <p>{device.kind}</p>
                  </div>
                  <code>{device.deviceId.slice(0, 8)}</code>
                </div>
              ))}
              {!devices.length ? <p className="hint">No devices listed yet.</p> : null}
            </div>
            <div>
              <span className="label">TURN config</span>
              <code>{turnConfig ? JSON.stringify(turnConfig) : "none"}</code>
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Login / bootstrap</h2>
          <form className="stack" onSubmit={handleLogin}>
            <label className="field">
              <span>Email</span>
              <input required type="email" value={loginForm.email} onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })} />
            </label>
            <label className="field">
              <span>Password (optional for dev)</span>
              <input type="password" value={loginForm.password} onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })} />
            </label>
            <label className="field">
              <span>Role</span>
              <select value={loginForm.role} onChange={(e) => setLoginForm({ ...loginForm, role: e.target.value })}>
                <option value="admin">Admin</option>
                <option value="user">User</option>
              </select>
            </label>
            <button type="submit">Authenticate</button>
          </form>
          <p className="hint">Backend seeds admin only when role=admin and DEV_AUTH_ENABLED=true.</p>
          <p className="status">{status}</p>
        </section>

        <section className="card">
          <h2>Schedule meeting</h2>
          <form className="stack" onSubmit={handleCreateMeeting}>
            <label className="field">
              <span>Title</span>
              <input value={meetingForm.title} onChange={(e) => setMeetingForm({ ...meetingForm, title: e.target.value })} />
            </label>
            <label className="field">
              <span>Start</span>
              <input type="datetime-local" value={meetingForm.startTime.slice(0, 16)} onChange={(e) => setMeetingForm({ ...meetingForm, startTime: new Date(e.target.value).toISOString() })} />
            </label>
            <label className="field">
              <span>End</span>
              <input type="datetime-local" value={meetingForm.endTime.slice(0, 16)} onChange={(e) => setMeetingForm({ ...meetingForm, endTime: new Date(e.target.value).toISOString() })} />
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={meetingForm.lobbyRequired} onChange={(e) => setMeetingForm({ ...meetingForm, lobbyRequired: e.target.checked })} />
              Lobby required
            </label>
            <button type="submit" disabled={!token}>
              Create meeting
            </button>
          </form>
          <div className="list">
            {meetings.map((m) => (
              <div key={m.id} className="list-item">
                <div>
                  <strong>{m.title}</strong>
                  <p>{new Date(m.startTime).toLocaleString()} → {new Date(m.endTime).toLocaleString()}</p>
                </div>
                <code>{m.id}</code>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <h2>Invites</h2>
          <form className="stack" onSubmit={handleCreateInvite}>
            <label className="field">
              <span>Meeting ID</span>
              <input value={inviteMeetingId} onChange={(e) => setInviteMeetingId(e.target.value)} placeholder="meeting id" />
            </label>
            <label className="field">
              <span>Email (optional for guest)</span>
              <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
            </label>
            <label className="field">
              <span>Role</span>
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                <option value="guest">Guest</option>
                <option value="user">User</option>
              </select>
            </label>
            <button type="submit" disabled={!token}>
              Create invite
            </button>
          </form>
          <pre className="invite-result">{inviteResult || "Awaiting invite..."}</pre>
        </section>

        <section className="card">
          <h2>Signaling check</h2>
          <form className="stack" onSubmit={connectSignaling}>
            <label className="field">
              <span>Meeting ID to join</span>
              <input value={meetingToJoin} onChange={(e) => setMeetingToJoin(e.target.value)} />
            </label>
            <div className="row">
              <button type="submit" disabled={!token}>
                Connect
              </button>
              <button type="button" onClick={disconnectSocket}>
                Disconnect
              </button>
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={autoReconnect} onChange={(e) => setAutoReconnect(e.target.checked)} />
              Auto-reconnect
            </label>
            <button type="button" onClick={() => sendSignal(JSON.stringify({ type: "ping", at: Date.now() }))}>
              Send ping
            </button>
            <div className="row">
              <button type="button" onClick={startCall} disabled={callActive}>
                Start call
              </button>
              <button type="button" onClick={endCall} disabled={!callActive}>
                End call
              </button>
              <button type="button" onClick={restartIce} disabled={!callActive}>
                Restart ICE
              </button>
            </div>
          </form>
          <div className="tiles">
            <div className="tile">
              <div className="tile-header">
                <strong>Local</strong>
                <span className={`badge ${connectionBadge(connectionState).tone}`}>
                  {connectionBadge(connectionState).label}
                </span>
              </div>
              <video ref={videoRef} autoPlay muted playsInline className="preview" />
            </div>
            <div className="tile">
              <div className="tile-header">
                <strong>Remote</strong>
                <span className={`badge ${connectionBadge(iceState === "idle" ? "idle" : connectionState).tone}`}>
                  {iceState}
                </span>
              </div>
              <video ref={remoteVideoRef} autoPlay playsInline className="preview remote" />
            </div>
          </div>
          <div className="list">
            {wsMessages.map((m, idx) => (
              <div key={idx} className="list-item">
                <code>{m}</code>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <h2>Meeting access control</h2>
          <div className="stack">
            <p className="hint">Host/admin controls for lobby, lock, and participant actions.</p>
            <div className="row">
              <button type="button" onClick={loadRoomState} disabled={!token || !meetingToJoin}>
                Refresh state
              </button>
              <button type="button" onClick={toggleRoomLock} disabled={!roomSnapshot}>
                {roomSnapshot?.locked ? "Unlock room" : "Lock room"}
              </button>
            </div>
            <p className="hint">Locked: {roomSnapshot?.locked ? "yes" : "no"}</p>
            <div className="tiles">
              <div className="tile">
                <div className="tile-header">
                  <strong>Lobby</strong>
                  <span className="badge warn">{roomSnapshot?.lobby.length ?? 0}</span>
                </div>
                {roomSnapshot?.lobby.map((entry) => (
                  <div key={entry.userId} className="list-item">
                    <div>
                      <strong>{entry.userId}</strong>
                      <p>{entry.role ?? "guest"}</p>
                    </div>
                    <div className="row">
                      <button type="button" onClick={() => admitUser(entry.userId)}>
                        Admit
                      </button>
                      <button type="button" onClick={() => denyUser(entry.userId)}>
                        Deny
                      </button>
                    </div>
                  </div>
                ))}
                {!roomSnapshot?.lobby.length ? <p className="hint">No one waiting.</p> : null}
              </div>
              <div className="tile">
                <div className="tile-header">
                  <strong>Participants</strong>
                  <span className="badge ok">{roomSnapshot?.participants.length ?? 0}</span>
                </div>
                {roomSnapshot?.participants.map((entry) => (
                  <div key={entry.userId} className="list-item">
                    <div>
                      <strong>{entry.userId}</strong>
                      <p>{entry.role ?? "user"}</p>
                    </div>
                    <div className="row">
                      <button type="button" onClick={() => muteUser(entry.userId)}>
                        {roomMuteState[entry.userId] ? "Unmute" : "Mute"}
                      </button>
                      <button type="button" onClick={() => kickUser(entry.userId)}>
                        Kick
                      </button>
                    </div>
                  </div>
                ))}
                {!roomSnapshot?.participants.length ? <p className="hint">No participants.</p> : null}
              </div>
            </div>
          </div>
        </section>

        <section className="card">
          <h2>LiveKit SFU</h2>
          <div className="stack">
            <p className="hint">Uses LiveKit server for SFU; requires a room id (meeting id).</p>
            <div className="row">
              <button type="button" onClick={joinLiveKit} disabled={livekitStatus === "connecting" || livekitStatus === "connected"}>
                Join LiveKit
              </button>
              <button type="button" onClick={leaveLiveKit} disabled={livekitStatus !== "connected"}>
                Leave LiveKit
              </button>
            </div>
            <p className="status">Status: {livekitStatus}</p>
            {livekitError ? <p className="status error">{livekitError}</p> : null}
            <p className="hint">Participants: {livekitParticipantCount}</p>
            <p className="hint">Remote tracks: {livekitTracks.length}</p>
            <p className="hint">Room state: {livekitRoomState}</p>
            <p className="hint">Signal state: {livekitSignalState} (reconnects: {livekitReconnects})</p>
            <div className="stats-grid">
              <div className="stat">
                <span className="label">Local video bitrate</span>
                <strong>{livekitLocalStats?.bitrateKbps ?? "-"} kbps</strong>
              </div>
              <div className="stat">
                <span className="label">Local packet loss</span>
                <strong>{livekitLocalStats?.packetLossPct ?? "-"}%</strong>
              </div>
              <div className="stat">
                <span className="label">Local audio bitrate</span>
                <strong>{livekitLocalAudioStats?.bitrateKbps ?? "-"} kbps</strong>
              </div>
              <div className="stat">
                <span className="label">Local audio loss</span>
                <strong>{livekitLocalAudioStats?.packetLossPct ?? "-"}%</strong>
              </div>
              <div className="stat">
                <span className="label">Publish quality</span>
                <strong>{VideoQuality[livekitQuality]}</strong>
              </div>
            </div>
            <div>
              <span className="label">LiveKit URL</span>
              <code>{livekitUrl ?? "none"}</code>
            </div>
            <div className="tiles">
              <div className="tile">
                <div className="tile-header">
                  <strong>Remote audio</strong>
                  <button type="button" className="chip" onClick={toggleMuteAllRemoteAudio}>
                    {muteAllRemoteAudio ? "Unmute all" : "Mute all"}
                  </button>
                </div>
                <p className="hint">Applies to all remote audio tracks.</p>
              </div>
              {livekitTracks.map((item) => (
                <LiveKitTrackTile
                  key={item.id}
                  item={item}
                  stats={livekitStats[item.id]}
                  quality={livekitQualityPrefs[item.id]}
                  onQualityChange={updateRemoteQuality}
                  subscribed={livekitSubscriptions[item.id] ?? true}
                  muted={livekitAudioMuted[item.id] ?? false}
                  onToggleSubscribe={toggleSubscription}
                  onToggleMute={toggleAudioMute}
                />
              ))}
              {!livekitTracks.length ? <p className="hint">No remote tracks yet.</p> : null}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function apiClient(apiBase: string, token: string) {
  const base = apiBase.replace(/\/$/, "") + "/api";
  return {
    async get(path: string) {
      return request("GET", base + path, undefined, token);
    },
    async post(path: string, body: unknown) {
      return request("POST", base + path, body, token);
    },
  };
}

async function request(method: string, url: string, body?: unknown, token?: string) {
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export default App;

function LiveKitTrackTile({
  item,
  stats,
  quality,
  onQualityChange,
  subscribed,
  muted,
  onToggleSubscribe,
  onToggleMute,
}: {
  item: LiveKitTrackItem;
  stats?: StatsSummary;
  quality?: VideoQuality;
  onQualityChange: (item: LiveKitTrackItem, quality: VideoQuality) => void;
  subscribed: boolean;
  muted: boolean;
  onToggleSubscribe: (item: LiveKitTrackItem) => void;
  onToggleMute: (item: LiveKitTrackItem) => void;
}) {
  const ref = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    item.track.attach(ref.current);
    return () => {
      item.track.detach(ref.current as HTMLMediaElement);
    };
  }, [item]);

  const title = item.participantName || item.participantIdentity;
  const isVideo = item.kind === "video";
  return (
    <div className="tile">
      <div className="tile-header">
        <strong>{title}</strong>
        <span className="badge ok">{item.kind}</span>
      </div>
      <div className="tile-stats">
        <span className="label">Bitrate</span>
        <strong>{stats?.bitrateKbps ?? "-"} kbps</strong>
        <span className="label">Loss</span>
        <strong>{stats?.packetLossPct ?? "-"}%</strong>
        <span className="label">Subscribed</span>
        <button type="button" className="chip" onClick={() => onToggleSubscribe(item)}>
          {subscribed ? "On" : "Off"}
        </button>
        {item.kind === "video" ? (
          <>
            <span className="label">Quality</span>
            <select
              value={quality ?? VideoQuality.HIGH}
              onChange={(e) => onQualityChange(item, Number(e.target.value) as VideoQuality)}
            >
              <option value={VideoQuality.HIGH}>High</option>
              <option value={VideoQuality.MEDIUM}>Medium</option>
              <option value={VideoQuality.LOW}>Low</option>
            </select>
          </>
        ) : (
          <>
            <span className="label">Muted</span>
            <button type="button" className="chip" onClick={() => onToggleMute(item)}>
              {muted ? "Muted" : "Live"}
            </button>
          </>
        )}
      </div>
      {isVideo ? (
        <video ref={ref as RefObject<HTMLVideoElement>} autoPlay playsInline className="preview remote" />
      ) : (
        <audio ref={ref as RefObject<HTMLAudioElement>} autoPlay muted={muted} />
      )}
    </div>
  );
}
