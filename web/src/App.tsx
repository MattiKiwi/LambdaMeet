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
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { computeBackoffMs } from "./lib/backoff";
import { normalizeLiveKitUrl } from "./lib/livekit";
import { buildIceConfig, connectionBadge, type TurnConfig } from "./lib/rtc";
import { isRoute, routes } from "./lib/routes";
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

type User = { id: string; email: string; fullName?: string | null; role: string };
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
  lobby: { userId: string; role?: string; name?: string | null }[];
  participants: { userId: string; role?: string; name?: string | null }[];
};
type JoinRequest = {
  id: string;
  userId: string;
  name?: string | null;
  role?: string;
  createdAt: number;
  expiresAt: number;
};
type UiToast = {
  id: string;
  message: string;
  expiresAt: number;
};
type ParticipantInfo = {
  identity: string;
  name?: string;
};

const DEFAULT_API = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const AUTH_STORAGE_KEY = "lambdameet.auth";
const JOIN_REQUEST_TTL_MS = 10000;
const DEVICE_PREFS_KEY = "lambdameet.devicePrefs";

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
  const [livekitParticipants, setLivekitParticipants] = useState<ParticipantInfo[]>([]);
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
  const [livekitActiveSpeakers, setLivekitActiveSpeakers] = useState<string[]>([]);
  const [livekitDominantSpeaker, setLivekitDominantSpeaker] = useState<string | null>(null);
  const [waitingForApproval, setWaitingForApproval] = useState(false);
  const [roomSnapshot, setRoomSnapshot] = useState<RoomSnapshot | null>(null);
  const [roomMuteState, setRoomMuteState] = useState<Record<string, boolean>>({});
  const [inviteMeetingId, setInviteMeetingId] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("guest");
  const [inviteResult, setInviteResult] = useState<string>("");
  const [users, setUsers] = useState<User[]>([]);
  const [userForm, setUserForm] = useState({
    id: "",
    email: "",
    fullName: "",
    role: "user",
    password: "",
  });
  const [userStatus, setUserStatus] = useState("");
  const [uiToasts, setUiToasts] = useState<UiToast[]>([]);
  const [status, setStatus] = useState<string>("");
  const [meetingToJoin, setMeetingToJoin] = useState("");
  const [wsStatus, setWsStatus] = useState("disconnected");
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const skipReconnectRef = useRef(false);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const [deviceError, setDeviceError] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState("");
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState("");
  const [previewActive, setPreviewActive] = useState(false);
  const [callActive, setCallActive] = useState(false);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState | "idle">("idle");
  const [callSettingsOpen, setCallSettingsOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [localMuted, setLocalMuted] = useState(false);
  const [localVideoOff, setLocalVideoOff] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const joinRequestTimersRef = useRef<Map<string, number>>(new Map());
  const lobbySeenRef = useRef<Set<string>>(new Set());
  const toastTimersRef = useRef<Map<string, number>>(new Map());
  const livekitStatsTimerRef = useRef<number | null>(null);
  const livekitLocalTrackRef = useRef<LocalVideoTrack | null>(null);
  const livekitLocalPrevRef = useRef<StatsSample | null>(null);
  const livekitLocalAudioRef = useRef<LocalAudioTrack | null>(null);
  const livekitLocalAudioPrevRef = useRef<StatsSample | null>(null);
  const livekitRemotePrevRef = useRef<Map<string, StatsSample>>(new Map());

  const api = useMemo(() => apiClient(apiBase, token), [apiBase, token]);
  const location = useLocation();
  const navigate = useNavigate();
  const canModerate = user?.role === "admin";
  const devicePrefsKey = `${DEVICE_PREFS_KEY}:${user?.id || "guest"}`;

  useEffect(() => {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return;
    try {
      const stored = JSON.parse(raw) as { token?: string; user?: User };
      if (stored?.token) {
        setToken(stored.token);
        setUser(stored.user ?? null);
      }
    } catch {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (!token) {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token, user }));
  }, [token, user]);

  useEffect(() => {
    const raw = window.localStorage.getItem(devicePrefsKey);
    if (!raw) {
      setSelectedAudioDeviceId("");
      setSelectedVideoDeviceId("");
      return;
    }
    try {
      const stored = JSON.parse(raw) as { audioId?: string; videoId?: string };
      setSelectedAudioDeviceId(stored.audioId || "");
      setSelectedVideoDeviceId(stored.videoId || "");
    } catch {
      window.localStorage.removeItem(devicePrefsKey);
      setSelectedAudioDeviceId("");
      setSelectedVideoDeviceId("");
    }
  }, [devicePrefsKey]);

  useEffect(() => {
    return () => {
      joinRequestTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      joinRequestTimersRef.current.clear();
      toastTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      toastTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!meetingToJoin || !token || !isRoute(location.pathname, "call")) return;
    let active = true;
    void loadRoomState();
    const timer = window.setInterval(() => {
      if (!active) return;
      void loadRoomState();
    }, 4000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [canModerate, meetingToJoin, token, location.pathname]);

  useEffect(() => {
    if (!isRoute(location.pathname, "user")) return;
    void listDevices();
  }, [location.pathname]);

  function setCopyFeedback(message: string) {
    setCopyStatus(message);
    if (copyTimerRef.current) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopyStatus("");
      copyTimerRef.current = null;
    }, 1500);
  }

  async function handleCopyMeetingId() {
    if (!meetingToJoin) {
      setCopyFeedback("No call ID");
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(meetingToJoin);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = meetingToJoin;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      setCopyFeedback("Copied");
    } catch {
      setCopyFeedback("Copy failed");
    }
  }

  function dismissToast(id: string) {
    setUiToasts((prev) => prev.filter((toast) => toast.id !== id));
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
  }

  function enqueueToast(message: string, ttlMs = 4000) {
    const id = `${Date.now()}-${Math.random()}`;
    const expiresAt = Date.now() + ttlMs;
    setUiToasts((prev) => [{ id, message, expiresAt }, ...prev].slice(0, 3));
    const timer = window.setTimeout(() => {
      dismissToast(id);
    }, ttlMs);
    toastTimersRef.current.set(id, timer);
  }

  function dismissJoinRequest(id: string) {
    setJoinRequests((prev) => prev.filter((req) => req.id !== id));
    const timer = joinRequestTimersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      joinRequestTimersRef.current.delete(id);
    }
  }

  function enqueueJoinRequest(entry: { userId: string; role?: string; name?: string | null }) {
    if (!meetingToJoin) return;
    const id = `${meetingToJoin}:${entry.userId}`;
    setJoinRequests((prev) => {
      if (prev.some((req) => req.id === id)) return prev;
      const createdAt = Date.now();
      const next: JoinRequest = {
        id,
        userId: entry.userId,
        name: entry.name ?? null,
        role: entry.role,
        createdAt,
        expiresAt: createdAt + JOIN_REQUEST_TTL_MS,
      };
      return [next, ...prev].slice(0, 4);
    });
    if (!joinRequestTimersRef.current.has(id)) {
      const timer = window.setTimeout(() => {
        dismissJoinRequest(id);
      }, JOIN_REQUEST_TTL_MS);
      joinRequestTimersRef.current.set(id, timer);
    }
  }

  useEffect(() => {
    if (!token) return;
    loadMeetings();
  }, [token]);

  useEffect(() => {
    if (!token || !canModerate) {
      setUsers([]);
      return;
    }
    loadUsers();
  }, [token, canModerate]);

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

  function saveDevicePreferences() {
    window.localStorage.setItem(
      devicePrefsKey,
      JSON.stringify({ audioId: selectedAudioDeviceId, videoId: selectedVideoDeviceId }),
    );
    enqueueToast("Saved device defaults");
  }

  async function loadUsers() {
    const res = await api.get("/users");
    if (!res.ok) {
      setUserStatus("Failed to load users");
      return;
    }
    setUsers(res.data.users ?? []);
  }

  function resetUserForm() {
    setUserForm({ id: "", email: "", fullName: "", role: "user", password: "" });
  }

  async function handleCreateUser(e: FormEvent) {
    e.preventDefault();
    setUserStatus("Creating user...");
    const res = await api.post("/users", {
      email: userForm.email,
      fullName: userForm.fullName || undefined,
      role: userForm.role,
      password: userForm.password || undefined,
    });
    if (!res.ok) {
      setUserStatus("Failed to create user");
      return;
    }
    setUserStatus("User created");
    resetUserForm();
    loadUsers();
  }

  async function handleUpdateUser(e: FormEvent) {
    e.preventDefault();
    if (!userForm.id) return;
    setUserStatus("Updating user...");
    const res = await api.put(`/users/${userForm.id}`, {
      email: userForm.email,
      fullName: userForm.fullName || null,
      role: userForm.role,
      password: userForm.password || undefined,
    });
    if (!res.ok) {
      setUserStatus("Failed to update user");
      return;
    }
    setUserStatus("User updated");
    resetUserForm();
    loadUsers();
  }

  async function handleDeleteUser(id: string) {
    const res = await api.delete(`/users/${id}`);
    if (!res.ok) {
      setUserStatus("Failed to delete user");
      return;
    }
    setUserStatus("User deleted");
    loadUsers();
  }

  async function handleForceDeleteUser(id: string) {
    const confirmed = window.confirm("Force delete this user and remove their hosted meetings?");
    if (!confirmed) return;
    const res = await api.delete(`/users/${id}?force=true`);
    if (!res.ok) {
      setUserStatus("Failed to force delete user");
      return;
    }
    setUserStatus("User deleted");
    loadUsers();
  }

  function handleEditUser(user: User) {
    setUserForm({
      id: user.id,
      email: user.email,
      fullName: user.fullName ?? "",
      role: user.role,
      password: "",
    });
  }

  function buildMediaConstraints() {
    const audio = selectedAudioDeviceId ? { deviceId: { exact: selectedAudioDeviceId } } : true;
    const video = selectedVideoDeviceId ? { deviceId: { exact: selectedVideoDeviceId } } : true;
    return { audio, video };
  }

  function applyLocalMuteState(muted: boolean) {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    if (stream) {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }
    const audioTrack = livekitLocalAudioRef.current;
    if (audioTrack) {
      if (muted) {
        audioTrack.mute();
      } else {
        audioTrack.unmute();
      }
    }
  }

  function applyLocalVideoState(off: boolean) {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    if (stream) {
      stream.getVideoTracks().forEach((track) => {
        track.enabled = !off;
      });
    }
    const videoTrack = livekitLocalTrackRef.current;
    if (videoTrack) {
      if (off) {
        videoTrack.mute();
      } else {
        videoTrack.unmute();
      }
    }
  }

  function connectSignaling(e?: FormEvent) {
    e?.preventDefault();
    if (!token || !meetingToJoin) {
      setWsStatus("token or meeting missing");
      return;
    }
    skipReconnectRef.current = false;
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
    socket.onclose = (event) => {
      setWsStatus("disconnected");
      handleSocketClose(event);
    };
    socket.onerror = () => setWsStatus("error");
    socket.onmessage = (evt) => {
      const payload = String(evt.data);
      handleSignal(payload);
    };
  }

  function disconnectSocket() {
    skipReconnectRef.current = true;
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
    if (skipReconnectRef.current || !autoReconnect || !token || !meetingToJoin) return;
    clearReconnectTimer();
    const nextAttempt = reconnectAttempts + 1;
    const delay = computeBackoffMs(nextAttempt, { baseMs: 500, maxMs: 8000 });
    reconnectTimerRef.current = window.setTimeout(() => {
      setReconnectAttempts(nextAttempt);
      connectSignaling();
    }, delay);
  }

  function handleSocketClose(event: CloseEvent) {
    if (event.code === 4001) {
      skipReconnectRef.current = true;
      setWaitingForApproval(false);
      setStatus("Denied by host");
      return;
    }
    if (event.code === 4002) {
      skipReconnectRef.current = true;
      setWaitingForApproval(false);
      setStatus("Kicked by host");
      void leaveLiveKit();
      void endCall();
      return;
    }
    scheduleReconnect();
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
      stream = await navigator.mediaDevices.getUserMedia(buildMediaConstraints());
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setPreviewActive(true);
    }
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !localMuted;
    });
    stream.getVideoTracks().forEach((track) => {
      track.enabled = !localVideoOff;
    });
    if (!pc.getSenders().some((sender) => sender.track)) {
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(JSON.stringify({ type: "offer", sdp: offer.sdp || "" } satisfies SignalMessage));
    setCallActive(true);
  }

  async function endCall() {
    pcRef.current?.close();
    pcRef.current = null;
    setConnectionState("closed");
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
      setWaitingForApproval(true);
      return;
    }
    if (message.type === "admitted") {
      setStatus("Admitted to meeting");
      setWaitingForApproval(false);
      if (wsStatus === "connected") {
        await startCall();
      }
      if (livekitStatus !== "connected" && livekitStatus !== "connecting") {
        await joinLiveKit();
      }
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
        const remotes = Array.from(room.remoteParticipants.values()).map((participant) => ({
          identity: participant.identity,
          name: participant.name,
        }));
        setLivekitParticipants(remotes);
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
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const identities = speakers.map((speaker) => speaker.identity);
        setLivekitActiveSpeakers(identities);
        setLivekitDominantSpeaker(identities[0] ?? null);
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
        setLivekitParticipants([]);
        setLivekitRoomState("disconnected");
        setLivekitActiveSpeakers([]);
        setLivekitDominantSpeaker(null);
      });
      setLivekitStatus("connecting");
      await room.connect(livekitUrl, livekitToken);
      const tracks = await createLocalTracks(buildMediaConstraints());
      tracks.forEach((track) => {
        room.localParticipant.publishTrack(track);
        if (track.kind === "video" && track instanceof LocalVideoTrack) {
          livekitLocalTrackRef.current = track;
        }
        if (track.kind === "audio" && track instanceof LocalAudioTrack) {
          livekitLocalAudioRef.current = track;
        }
      });
      applyLocalMuteState(localMuted);
      applyLocalVideoState(localVideoOff);
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
    setLivekitParticipants([]);
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
    setLivekitActiveSpeakers([]);
    setLivekitDominantSpeaker(null);
    livekitLocalPrevRef.current = null;
    livekitLocalAudioPrevRef.current = null;
    livekitRemotePrevRef.current = new Map();
    if (livekitStatsTimerRef.current) {
      window.clearInterval(livekitStatsTimerRef.current);
      livekitStatsTimerRef.current = null;
    }
  }

  async function applySelectedDevices() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(buildMediaConstraints());
      const oldStream = videoRef.current?.srcObject as MediaStream | null;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      oldStream?.getTracks().forEach((track) => track.stop());
      setPreviewActive(true);
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !localMuted;
      });
      stream.getVideoTracks().forEach((track) => {
        track.enabled = !localVideoOff;
      });
      if (pcRef.current) {
        const senders = pcRef.current.getSenders();
        const nextAudio = stream.getAudioTracks()[0] ?? null;
        const nextVideo = stream.getVideoTracks()[0] ?? null;
        const audioSender = senders.find((sender) => sender.track?.kind === "audio");
        const videoSender = senders.find((sender) => sender.track?.kind === "video");
        if (audioSender && nextAudio) {
          await audioSender.replaceTrack(nextAudio);
        } else if (nextAudio) {
          pcRef.current.addTrack(nextAudio, stream);
        }
        if (videoSender && nextVideo) {
          await videoSender.replaceTrack(nextVideo);
        } else if (nextVideo) {
          pcRef.current.addTrack(nextVideo, stream);
        }
      }
      if (livekitRoom) {
        const localParticipant = livekitRoom.localParticipant;
        localParticipant.trackPublications.forEach((pub) => {
          if (pub.track) {
            localParticipant.unpublishTrack(pub.track);
            pub.track.stop();
          }
        });
        livekitLocalTrackRef.current = null;
        livekitLocalAudioRef.current = null;
        const freshTracks = await createLocalTracks(buildMediaConstraints());
        freshTracks.forEach((track) => {
          localParticipant.publishTrack(track);
          if (track.kind === "video" && track instanceof LocalVideoTrack) {
            livekitLocalTrackRef.current = track;
          }
          if (track.kind === "audio" && track instanceof LocalAudioTrack) {
            livekitLocalAudioRef.current = track;
          }
        });
        applyLocalMuteState(localMuted);
        applyLocalVideoState(localVideoOff);
      }
      setStatus("Devices updated");
    } catch (err) {
      setStatus((err as Error).message || "Failed to apply devices");
    }
  }

  function toggleLocalMute() {
    const next = !localMuted;
    setLocalMuted(next);
    applyLocalMuteState(next);
  }

  function toggleLocalVideo() {
    const next = !localVideoOff;
    setLocalVideoOff(next);
    applyLocalVideoState(next);
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

  async function ensureSignalingConnected() {
    if (wsRef.current?.readyState === WebSocket.OPEN) return true;
    connectSignaling();
    const socket = wsRef.current;
    if (!socket) return false;
    return await new Promise<boolean>((resolve) => {
      if (socket.readyState === WebSocket.OPEN) {
        resolve(true);
        return;
      }
      const timer = window.setTimeout(() => {
        cleanup();
        resolve(false);
      }, 3000);
      const onOpen = () => {
        cleanup();
        resolve(true);
      };
      const onClose = () => {
        cleanup();
        resolve(false);
      };
      const cleanup = () => {
        window.clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("close", onClose);
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("close", onClose);
    });
  }

  async function toggleCall() {
    const isConnected = wsStatus === "connected" || callActive || livekitStatus === "connected";
    if (isConnected) {
      skipReconnectRef.current = true;
      setWaitingForApproval(false);
      await leaveLiveKit();
      await endCall();
      disconnectSocket();
      return;
    }
    skipReconnectRef.current = false;
    const signalingReady = await ensureSignalingConnected();
    if (!signalingReady) {
      setStatus("Signaling not connected");
      return;
    }
    await startCall();
    await joinLiveKit();
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
    const snapshot = res.data as RoomSnapshot;
    setRoomSnapshot(snapshot);
    if (canModerate && isRoute(location.pathname, "call")) {
      const nextLobbyIds = new Set(snapshot.lobby.map((entry) => entry.userId));
      snapshot.lobby.forEach((entry) => {
        if (!lobbySeenRef.current.has(entry.userId)) {
          enqueueJoinRequest(entry);
        }
      });
      lobbySeenRef.current = nextLobbyIds;
    }
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

  async function approveJoinRequest(userId: string) {
    await admitUser(userId);
    if (meetingToJoin) {
      dismissJoinRequest(`${meetingToJoin}:${userId}`);
    }
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

  async function rejectJoinRequest(userId: string) {
    await denyUser(userId);
    if (meetingToJoin) {
      dismissJoinRequest(`${meetingToJoin}:${userId}`);
    }
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
      const stream = await navigator.mediaDevices.getUserMedia(buildMediaConstraints());
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

  const routeTitle = isRoute(location.pathname, "admin")
    ? "Admin Space"
    : isRoute(location.pathname, "call")
    ? "Call Room"
    : isRoute(location.pathname, "login")
    ? "Login"
    : "User Space";

  function handleLogout() {
    setToken("");
    setUser(null);
    setStatus("");
    navigate(routes.login);
  }

  return (
    <div className={`shell ${isRoute(location.pathname, "call") ? "call-mode" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <span>LambdaMeet</span>
          <p>Secure WebRTC rooms</p>
        </div>
        <nav className="sidebar-nav">
          <Link className={isRoute(location.pathname, "user") ? "active" : ""} to={routes.user}>
            User Space
          </Link>
          <Link className={isRoute(location.pathname, "admin") ? "active" : ""} to={routes.admin}>
            Admin Space
          </Link>
          <Link className={isRoute(location.pathname, "call") ? "active" : ""} to={routes.call}>
            Call Room
          </Link>
        </nav>
        <div className="sidebar-meta">
          <div>
            <span className="label">Signed in</span>
            <strong>{user ? user.fullName || user.email : "Guest"}</strong>
          </div>
          <div>
            <span className="label">Role</span>
            <strong>{user?.role ?? "none"}</strong>
          </div>
        </div>
      </aside>

      <div className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">LambdaMeet</p>
            <h1>{routeTitle}</h1>
          </div>
          <div className="topbar-status">
            <div className="topbar-call">
              <span className="label">Call ID</span>
              <button type="button" className="copy-button" onClick={handleCopyMeetingId} disabled={!meetingToJoin}>
                {meetingToJoin || "Set meeting ID"}
              </button>
              {copyStatus ? <span className="copy-status">{copyStatus}</span> : null}
            </div>
            {user ? (
              <button type="button" className="chip" onClick={handleLogout}>
                Log out
              </button>
            ) : null}
          </div>
        </header>

        <Routes>
          <Route
            path={routes.login}
            element={
              <LoginSpace
                status={status}
                loginForm={loginForm}
                setLoginForm={setLoginForm}
                handleLogin={handleLogin}
              />
            }
          />
          <Route
            path={routes.user}
            element={
              <UserSpace
                apiBase={apiBase}
                setApiBase={setApiBase}
                startPreview={startPreview}
                stopPreview={stopPreview}
                listDevices={listDevices}
                deviceError={deviceError}
                previewActive={previewActive}
                videoRef={videoRef}
                devices={devices}
                selectedAudioDeviceId={selectedAudioDeviceId}
                selectedVideoDeviceId={selectedVideoDeviceId}
                setSelectedAudioDeviceId={setSelectedAudioDeviceId}
                setSelectedVideoDeviceId={setSelectedVideoDeviceId}
                saveDevicePreferences={saveDevicePreferences}
                uiToasts={uiToasts}
                meetings={meetings}
                meetingToJoin={meetingToJoin}
                setMeetingToJoin={setMeetingToJoin}
                token={token}
                onGoToCall={() => navigate(routes.call)}
              />
            }
          />
          <Route
            path={routes.admin}
            element={
              <AdminSpace
                token={token}
                meetingForm={meetingForm}
                setMeetingForm={setMeetingForm}
                handleCreateMeeting={handleCreateMeeting}
                meetings={meetings}
                inviteMeetingId={inviteMeetingId}
                setInviteMeetingId={setInviteMeetingId}
                inviteEmail={inviteEmail}
                setInviteEmail={setInviteEmail}
                inviteRole={inviteRole}
                setInviteRole={setInviteRole}
                handleCreateInvite={handleCreateInvite}
                inviteResult={inviteResult}
                loadRoomState={loadRoomState}
                meetingToJoin={meetingToJoin}
                setMeetingToJoin={setMeetingToJoin}
                toggleRoomLock={toggleRoomLock}
                roomSnapshot={roomSnapshot}
                admitUser={admitUser}
                denyUser={denyUser}
                muteUser={muteUser}
                kickUser={kickUser}
                roomMuteState={roomMuteState}
                users={users}
                userForm={userForm}
                setUserForm={setUserForm}
                userStatus={userStatus}
                handleCreateUser={handleCreateUser}
                handleUpdateUser={handleUpdateUser}
                handleDeleteUser={handleDeleteUser}
                handleForceDeleteUser={handleForceDeleteUser}
                handleEditUser={handleEditUser}
                resetUserForm={resetUserForm}
              />
            }
          />
          <Route
            path={routes.call}
            element={
              <CallSpace
                token={token}
                meetingToJoin={meetingToJoin}
                setMeetingToJoin={setMeetingToJoin}
                wsStatus={wsStatus}
                autoReconnect={autoReconnect}
                setAutoReconnect={setAutoReconnect}
                callActive={callActive}
                connectionState={connectionState}
                videoRef={videoRef}
                livekitStatus={livekitStatus}
                livekitError={livekitError}
                livekitParticipantCount={livekitParticipantCount}
                livekitTracks={livekitTracks}
                livekitParticipants={livekitParticipants}
                livekitRoomState={livekitRoomState}
                livekitSignalState={livekitSignalState}
                livekitReconnects={livekitReconnects}
                livekitLocalStats={livekitLocalStats}
                livekitLocalAudioStats={livekitLocalAudioStats}
                livekitQuality={livekitQuality}
                livekitUrl={livekitUrl}
                muteAllRemoteAudio={muteAllRemoteAudio}
                toggleMuteAllRemoteAudio={toggleMuteAllRemoteAudio}
                livekitStats={livekitStats}
                livekitQualityPrefs={livekitQualityPrefs}
                updateRemoteQuality={updateRemoteQuality}
                livekitSubscriptions={livekitSubscriptions}
                livekitAudioMuted={livekitAudioMuted}
                toggleSubscription={toggleSubscription}
                toggleAudioMute={toggleAudioMute}
                toggleCall={toggleCall}
                livekitActiveSpeakers={livekitActiveSpeakers}
                livekitDominantSpeaker={livekitDominantSpeaker}
                roomSnapshot={roomSnapshot}
                roomMuteState={roomMuteState}
                loadRoomState={loadRoomState}
                toggleRoomLock={toggleRoomLock}
                admitUser={approveJoinRequest}
                denyUser={rejectJoinRequest}
                muteUser={muteUser}
                kickUser={kickUser}
                waitingForApproval={waitingForApproval}
                callSettingsOpen={callSettingsOpen}
                setCallSettingsOpen={setCallSettingsOpen}
                canModerate={canModerate}
                joinRequests={joinRequests}
                approveJoinRequest={approveJoinRequest}
                rejectJoinRequest={rejectJoinRequest}
                localMuted={localMuted}
                localVideoOff={localVideoOff}
                toggleLocalMute={toggleLocalMute}
                toggleLocalVideo={toggleLocalVideo}
                devices={devices}
                listDevices={listDevices}
                deviceError={deviceError}
                selectedAudioDeviceId={selectedAudioDeviceId}
                selectedVideoDeviceId={selectedVideoDeviceId}
                setSelectedAudioDeviceId={setSelectedAudioDeviceId}
                setSelectedVideoDeviceId={setSelectedVideoDeviceId}
                applySelectedDevices={applySelectedDevices}
              />
            }
          />
          <Route path="*" element={<Navigate to={routes.user} replace />} />
        </Routes>
      </div>
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
    async put(path: string, body: unknown) {
      return request("PUT", base + path, body, token);
    },
    async delete(path: string) {
      return request("DELETE", base + path, undefined, token);
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

function UserSpace({
  apiBase,
  setApiBase,
  startPreview,
  stopPreview,
  listDevices,
  deviceError,
  previewActive,
  videoRef,
  devices,
  selectedAudioDeviceId,
  selectedVideoDeviceId,
  setSelectedAudioDeviceId,
  setSelectedVideoDeviceId,
  saveDevicePreferences,
  uiToasts,
  meetings,
  meetingToJoin,
  setMeetingToJoin,
  token,
  onGoToCall,
}: {
  apiBase: string;
  setApiBase: (value: string) => void;
  startPreview: () => Promise<void>;
  stopPreview: () => void;
  listDevices: () => Promise<void>;
  deviceError: string;
  previewActive: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  devices: MediaDeviceInfo[];
  selectedAudioDeviceId: string;
  selectedVideoDeviceId: string;
  setSelectedAudioDeviceId: (value: string) => void;
  setSelectedVideoDeviceId: (value: string) => void;
  saveDevicePreferences: () => void;
  uiToasts: UiToast[];
  meetings: Meeting[];
  meetingToJoin: string;
  setMeetingToJoin: (value: string) => void;
  token: string;
  onGoToCall: () => void;
}) {
  return (
    <main className="workspace user-space">
      <section className="workspace-hero">
        <div>
          <p className="eyebrow">User space</p>
          <h2>Ready to join your next session?</h2>
          <p className="hint">Jump straight into a room or check your devices before joining.</p>
        </div>
        <div className="hero-actions">
          <label className="field">
            <span>Meeting ID</span>
            <input value={meetingToJoin} onChange={(e) => setMeetingToJoin(e.target.value)} />
          </label>
          <button type="button" onClick={onGoToCall} disabled={!token || !meetingToJoin}>
            Join Call Room
          </button>
          {!token ? (
            <Link className="chip" to={routes.login}>
              Go to login
            </Link>
          ) : null}
        </div>
      </section>

      <section className="workspace-grid">
        <div className="panel">
          <div className="panel-head">
            <h3>Upcoming meetings</h3>
            <p className="hint">Your scheduled sessions show up here once loaded.</p>
          </div>
          <div className="meeting-list">
            {meetings.map((m) => (
              <div key={m.id} className="meeting-card">
                <div>
                  <strong>{m.title}</strong>
                  <p>{new Date(m.startTime).toLocaleString()} → {new Date(m.endTime).toLocaleString()}</p>
                </div>
                <code>{m.id}</code>
              </div>
            ))}
            {!meetings.length ? <p className="hint">No meetings yet.</p> : null}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h3>Device check</h3>
            <p className="hint">Confirm mic/camera readiness before you join.</p>
          </div>
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
            <div className="row">
              <label className="field">
                <span>Microphone</span>
                <select value={selectedAudioDeviceId} onChange={(e) => setSelectedAudioDeviceId(e.target.value)}>
                  <option value="">Default microphone</option>
                  {devices
                    .filter((device) => device.kind === "audioinput")
                    .map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || "Microphone"}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Camera</span>
                <select value={selectedVideoDeviceId} onChange={(e) => setSelectedVideoDeviceId(e.target.value)}>
                  <option value="">Default camera</option>
                  {devices
                    .filter((device) => device.kind === "videoinput")
                    .map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || "Camera"}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <button type="button" className="chip" onClick={saveDevicePreferences}>
              Save device defaults
            </button>
            {deviceError ? <p className="status error">{deviceError}</p> : null}
            <video ref={videoRef} autoPlay muted playsInline className="preview" />
          </div>
        </div>
      </section>

      {uiToasts.length ? (
        <div className="toast-stack" aria-live="polite">
          {uiToasts.map((toast) => (
            <div key={toast.id} className="toast">
              <div className="toast-content">
                <div>
                  <strong>Notification</strong>
                  <p>{toast.message}</p>
                </div>
              </div>
              <div
                className="toast-progress"
                style={{ ["--toast-duration" as string]: `${Math.max(toast.expiresAt - Date.now(), 0)}ms` }}
              />
            </div>
          ))}
        </div>
      ) : null}
    </main>
  );
}

function LoginSpace({
  status,
  loginForm,
  setLoginForm,
  handleLogin,
}: {
  status: string;
  loginForm: { email: string; password: string; role: string };
  setLoginForm: (value: { email: string; password: string; role: string }) => void;
  handleLogin: (e: FormEvent) => Promise<void>;
}) {
  return (
    <main className="workspace">
      <section className="panel login-panel">
        <h2>Sign in</h2>
        <form className="stack" onSubmit={handleLogin}>
          <label className="field">
            <span>Email</span>
            <input required type="email" value={loginForm.email} onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })} />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" value={loginForm.password} onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })} />
          </label>
          <button type="submit">Authenticate</button>
        </form>
        <p className="status">{status}</p>
      </section>
    </main>
  );
}

function AdminSpace({
  token,
  meetingForm,
  setMeetingForm,
  handleCreateMeeting,
  meetings,
  inviteMeetingId,
  setInviteMeetingId,
  inviteEmail,
  setInviteEmail,
  inviteRole,
  setInviteRole,
  handleCreateInvite,
  inviteResult,
  loadRoomState,
  meetingToJoin,
  setMeetingToJoin,
  toggleRoomLock,
  roomSnapshot,
  admitUser,
  denyUser,
  muteUser,
  kickUser,
  roomMuteState,
  users,
  userForm,
  setUserForm,
  userStatus,
  handleCreateUser,
  handleUpdateUser,
  handleDeleteUser,
  handleForceDeleteUser,
  handleEditUser,
  resetUserForm,
}: {
  token: string;
  meetingForm: { title: string; startTime: string; endTime: string; lobbyRequired: boolean };
  setMeetingForm: (value: { title: string; startTime: string; endTime: string; lobbyRequired: boolean }) => void;
  handleCreateMeeting: (e: FormEvent) => Promise<void>;
  meetings: Meeting[];
  inviteMeetingId: string;
  setInviteMeetingId: (value: string) => void;
  inviteEmail: string;
  setInviteEmail: (value: string) => void;
  inviteRole: string;
  setInviteRole: (value: string) => void;
  handleCreateInvite: (e: FormEvent) => Promise<void>;
  inviteResult: string;
  loadRoomState: () => Promise<void>;
  meetingToJoin: string;
  setMeetingToJoin: (value: string) => void;
  toggleRoomLock: () => Promise<void>;
  roomSnapshot: RoomSnapshot | null;
  admitUser: (userId: string) => Promise<void>;
  denyUser: (userId: string) => Promise<void>;
  muteUser: (userId: string) => Promise<void>;
  kickUser: (userId: string) => Promise<void>;
  roomMuteState: Record<string, boolean>;
  users: User[];
  userForm: { id: string; email: string; fullName: string; role: string; password: string };
  setUserForm: (value: { id: string; email: string; fullName: string; role: string; password: string }) => void;
  userStatus: string;
  handleCreateUser: (e: FormEvent) => Promise<void>;
  handleUpdateUser: (e: FormEvent) => Promise<void>;
  handleDeleteUser: (id: string) => Promise<void>;
  handleForceDeleteUser: (id: string) => Promise<void>;
  handleEditUser: (user: User) => void;
  resetUserForm: () => void;
}) {
  return (
    <main className="workspace admin-space">
      <section className="workspace-hero admin-hero">
        <div>
          <p className="eyebrow">Admin space</p>
          <h2>Control the room schedule and moderation.</h2>
          <p className="hint">Create meetings, issue invites, and manage access in one place.</p>
        </div>
        <div className="hero-actions">
          <label className="field">
            <span>Meeting ID</span>
            <input value={meetingToJoin} onChange={(e) => setMeetingToJoin(e.target.value)} />
          </label>
          <div className="row">
            <button type="button" onClick={loadRoomState} disabled={!token || !meetingToJoin}>
              Refresh room state
            </button>
            <button type="button" onClick={toggleRoomLock} disabled={!roomSnapshot}>
              {roomSnapshot?.locked ? "Unlock room" : "Lock room"}
            </button>
          </div>
          <p className="hint">Locked: {roomSnapshot?.locked ? "yes" : "no"}</p>
        </div>
      </section>

      <section className="workspace-grid">
        <div className="panel">
          <div className="panel-head">
            <h3>Schedule meeting</h3>
            <p className="hint">Define the agenda and lobby policy for each session.</p>
          </div>
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
          <div className="meeting-list">
            {meetings.map((m) => (
              <div key={m.id} className="meeting-card">
                <div>
                  <strong>{m.title}</strong>
                  <p>{new Date(m.startTime).toLocaleString()} → {new Date(m.endTime).toLocaleString()}</p>
                </div>
                <code>{m.id}</code>
              </div>
            ))}
            {!meetings.length ? <p className="hint">No meetings scheduled yet.</p> : null}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h3>Invites</h3>
            <p className="hint">Send a link to guests, users, or staff.</p>
          </div>
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
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>User management</h3>
          <p className="hint">Create, update, or remove platform users.</p>
        </div>
        <div className="stack">
          <form className="stack" onSubmit={userForm.id ? handleUpdateUser : handleCreateUser}>
            <label className="field">
              <span>Full name</span>
              <input value={userForm.fullName} onChange={(e) => setUserForm({ ...userForm, fullName: e.target.value })} />
            </label>
            <label className="field">
              <span>Email</span>
              <input required type="email" value={userForm.email} onChange={(e) => setUserForm({ ...userForm, email: e.target.value })} />
            </label>
            <label className="field">
              <span>Role</span>
              <select value={userForm.role} onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}>
                <option value="admin">Admin</option>
                <option value="user">User</option>
              </select>
            </label>
            <label className="field">
              <span>Password (optional)</span>
              <input
                type="password"
                value={userForm.password}
                onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
              />
            </label>
            <div className="row">
              <button type="submit">{userForm.id ? "Update user" : "Create user"}</button>
              {userForm.id ? (
                <button type="button" className="chip" onClick={resetUserForm}>
                  Cancel edit
                </button>
              ) : null}
            </div>
          </form>
          {userStatus ? <p className="hint">{userStatus}</p> : null}
          <div className="list">
            {users.map((userItem) => (
              <div key={userItem.id} className="list-item">
                <div>
                  <strong>{userItem.fullName || userItem.email}</strong>
                  <p>{userItem.role}</p>
                </div>
                <div className="row">
                  <button type="button" className="chip" onClick={() => handleEditUser(userItem)}>
                    Edit
                  </button>
                  <button type="button" className="chip" onClick={() => handleDeleteUser(userItem.id)}>
                    Remove
                  </button>
                  <button type="button" className="chip" onClick={() => handleForceDeleteUser(userItem.id)}>
                    Force remove
                  </button>
                </div>
              </div>
            ))}
            {!users.length ? <p className="hint">No users yet.</p> : null}
          </div>
        </div>
      </section>

      <section className="panel moderation-panel">
        <div className="panel-head">
          <h3>Meeting access control</h3>
          <p className="hint">Review lobby entries and manage active participants.</p>
        </div>
        <div className="tiles moderation-grid">
          <div className="tile">
            <div className="tile-header">
              <strong>Lobby</strong>
              <span className="badge warn">{roomSnapshot?.lobby.length ?? 0}</span>
            </div>
            {roomSnapshot?.lobby.map((entry) => (
              <div key={entry.userId} className="list-item">
                <div>
                  <strong>{entry.name || entry.userId}</strong>
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
                  <strong>{entry.name || entry.userId}</strong>
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
      </section>
    </main>
  );
}

function CallSpace({
  token,
  meetingToJoin,
  setMeetingToJoin,
  wsStatus,
  autoReconnect,
  setAutoReconnect,
  callActive,
  connectionState,
  videoRef,
  livekitStatus,
  livekitError,
  livekitParticipantCount,
  livekitTracks,
  livekitParticipants,
  livekitRoomState,
  livekitSignalState,
  livekitReconnects,
  livekitLocalStats,
  livekitLocalAudioStats,
  livekitQuality,
  livekitUrl,
  muteAllRemoteAudio,
  toggleMuteAllRemoteAudio,
  livekitStats,
  livekitQualityPrefs,
  updateRemoteQuality,
  livekitSubscriptions,
  livekitAudioMuted,
  toggleSubscription,
  toggleAudioMute,
  toggleCall,
  livekitActiveSpeakers,
  livekitDominantSpeaker,
  roomSnapshot,
  roomMuteState,
  loadRoomState,
  toggleRoomLock,
  admitUser,
  denyUser,
  muteUser,
  kickUser,
  waitingForApproval,
  callSettingsOpen,
  setCallSettingsOpen,
  canModerate,
  joinRequests,
  approveJoinRequest,
  rejectJoinRequest,
  localMuted,
  localVideoOff,
  toggleLocalMute,
  toggleLocalVideo,
  devices,
  listDevices,
  deviceError,
  selectedAudioDeviceId,
  selectedVideoDeviceId,
  setSelectedAudioDeviceId,
  setSelectedVideoDeviceId,
  applySelectedDevices,
}: {
  token: string;
  meetingToJoin: string;
  setMeetingToJoin: (value: string) => void;
  wsStatus: string;
  autoReconnect: boolean;
  setAutoReconnect: (value: boolean) => void;
  callActive: boolean;
  connectionState: RTCPeerConnectionState | "idle";
  videoRef: RefObject<HTMLVideoElement | null>;
  livekitStatus: string;
  livekitError: string;
  livekitParticipantCount: number;
  livekitTracks: LiveKitTrackItem[];
  livekitParticipants: ParticipantInfo[];
  livekitRoomState: string;
  livekitSignalState: string;
  livekitReconnects: number;
  livekitLocalStats: StatsSummary | null;
  livekitLocalAudioStats: StatsSummary | null;
  livekitQuality: VideoQuality;
  livekitUrl: string | null;
  muteAllRemoteAudio: boolean;
  toggleMuteAllRemoteAudio: () => void;
  livekitStats: Record<string, StatsSummary>;
  livekitQualityPrefs: Record<string, VideoQuality>;
  updateRemoteQuality: (item: LiveKitTrackItem, quality: VideoQuality) => void;
  livekitSubscriptions: Record<string, boolean>;
  livekitAudioMuted: Record<string, boolean>;
  toggleSubscription: (item: LiveKitTrackItem) => void;
  toggleAudioMute: (item: LiveKitTrackItem) => void;
  toggleCall: () => Promise<void>;
  livekitActiveSpeakers: string[];
  livekitDominantSpeaker: string | null;
  roomSnapshot: RoomSnapshot | null;
  roomMuteState: Record<string, boolean>;
  loadRoomState: () => Promise<void>;
  toggleRoomLock: () => Promise<void>;
  admitUser: (userId: string) => Promise<void>;
  denyUser: (userId: string) => Promise<void>;
  muteUser: (userId: string) => Promise<void>;
  kickUser: (userId: string) => Promise<void>;
  waitingForApproval: boolean;
  callSettingsOpen: boolean;
  setCallSettingsOpen: (value: boolean) => void;
  canModerate: boolean;
  joinRequests: JoinRequest[];
  approveJoinRequest: (userId: string) => Promise<void>;
  rejectJoinRequest: (userId: string) => Promise<void>;
  localMuted: boolean;
  localVideoOff: boolean;
  toggleLocalMute: () => void;
  toggleLocalVideo: () => void;
  devices: MediaDeviceInfo[];
  listDevices: () => Promise<void>;
  deviceError: string;
  selectedAudioDeviceId: string;
  selectedVideoDeviceId: string;
  setSelectedAudioDeviceId: (value: string) => void;
  setSelectedVideoDeviceId: (value: string) => void;
  applySelectedDevices: () => Promise<void>;
}) {
  const isConnected = wsStatus === "connected" || callActive || livekitStatus === "connected";
  const toggleDisabled =
    !token || !meetingToJoin || livekitStatus === "connecting" || wsStatus === "connecting";
  const activeSpeakerSet = useMemo(() => new Set(livekitActiveSpeakers), [livekitActiveSpeakers]);
  const trackByParticipant = useMemo(() => {
    const byParticipant = new Map<string, LiveKitTrackItem>();
    livekitTracks.forEach((track) => {
      if (track.kind === "video") {
        byParticipant.set(track.participantIdentity, track);
        return;
      }
      if (!byParticipant.has(track.participantIdentity)) {
        byParticipant.set(track.participantIdentity, track);
      }
    });
    return byParticipant;
  }, [livekitTracks]);
  const visibleParticipants = useMemo(() => {
    if (livekitParticipants.length) return livekitParticipants;
    const fallback = new Map<string, ParticipantInfo>();
    livekitTracks.forEach((track) => {
      if (!fallback.has(track.participantIdentity)) {
        fallback.set(track.participantIdentity, {
          identity: track.participantIdentity,
          name: track.participantName,
        });
      }
    });
    return Array.from(fallback.values());
  }, [livekitParticipants, livekitTracks]);
  const allowedParticipants = useMemo(() => {
    if (!roomSnapshot?.participants?.length) return visibleParticipants;
    const allowed = new Set(roomSnapshot.participants.map((entry) => entry.userId));
    return visibleParticipants.filter((participant) => allowed.has(participant.identity));
  }, [roomSnapshot, visibleParticipants]);
  const focusedIdentity = !canModerate
    ? livekitDominantSpeaker || allowedParticipants[0]?.identity
    : null;
  const focusedRemoteTrack = focusedIdentity ? trackByParticipant.get(focusedIdentity) : undefined;
  const focusedRemoteInfo = focusedIdentity
    ? allowedParticipants.find((participant) => participant.identity === focusedIdentity)
    : undefined;
  const sideParticipants = canModerate
    ? allowedParticipants
    : allowedParticipants.filter((participant) => participant.identity !== focusedIdentity);

  return (
    <main className="call-room">
      <section className="call-stage">
        <header className="call-stage-header">
          <div>
            <p className="eyebrow">Live call</p>
            <h2>Call Room</h2>
            <p className="hint">Signaling: {wsStatus}</p>
          </div>
          <div className="call-indicators">
            <span className="pill">LiveKit: {livekitStatus}</span>
            <span className="pill">Room: {livekitRoomState}</span>
          </div>
        </header>
        {waitingForApproval ? (
          <div className="call-banner">
            <strong>Waiting for approval</strong>
            <span>Your host will admit you shortly.</span>
          </div>
        ) : null}
        <div className="focus-layout">
          <div className="focus-main">
            {canModerate ? (
              <div className="focus-tile">
                <div className="tile-header">
                  <strong>You (Host)</strong>
                  <span className={`badge ${connectionBadge(connectionState).tone}`}>
                    {connectionBadge(connectionState).label}
                  </span>
                </div>
                <video ref={videoRef} autoPlay muted playsInline className="focus-video" />
              </div>
            ) : focusedRemoteTrack ? (
              <LiveKitFocusTile
                item={focusedRemoteTrack}
                isSpeaking={activeSpeakerSet.has(focusedRemoteTrack.participantIdentity)}
              />
            ) : focusedRemoteInfo ? (
              <FocusPlaceholder name={focusedRemoteInfo.name || focusedRemoteInfo.identity} />
            ) : (
              <div className="focus-tile empty">
                <strong>Waiting for participants...</strong>
              </div>
            )}
          </div>
          <div className="focus-side">
            {sideParticipants.map((participant) => {
              const track = trackByParticipant.get(participant.identity);
              if (track) {
                return (
                  <LiveKitSideTile
                    key={track.id}
                    item={track}
                    isSpeaking={activeSpeakerSet.has(track.participantIdentity)}
                  />
                );
              }
              return (
                <SidePlaceholder
                  key={participant.identity}
                  name={participant.name || participant.identity}
                />
              );
            })}
            {!sideParticipants.length ? <p className="hint">No other participants yet.</p> : null}
          </div>
        </div>
        <div className="call-controls">
          <div className="control-group">
            <button type="button" className="primary" onClick={toggleCall} disabled={toggleDisabled}>
              {isConnected ? "Leave call" : "Join call"}
            </button>
            <button type="button" className="chip" onClick={toggleLocalMute}>
              {localMuted ? "Unmute" : "Mute"}
            </button>
            <button type="button" className="chip" onClick={toggleLocalVideo}>
              {localVideoOff ? "Camera on" : "Camera off"}
            </button>
            <button type="button" className="icon-button" onClick={() => setCallSettingsOpen(true)}>
              ⚙
            </button>
          </div>
          <div className="control-group">
            {canModerate ? (
              <button type="button" className="chip" onClick={toggleMuteAllRemoteAudio}>
                {muteAllRemoteAudio ? "Unmute all" : "Mute all"}
              </button>
            ) : null}
          </div>
        </div>
      </section>

      {canModerate ? (
        <div className="toast-stack" aria-live="polite">
          {joinRequests.map((request) => (
            <div key={request.id} className="toast">
              <div className="toast-content">
                <div>
                  <strong>Join request</strong>
                  <p>
                    {request.name || request.userId} {request.role ? `(${request.role})` : ""}
                  </p>
                </div>
                <div className="row">
                  <button type="button" onClick={() => approveJoinRequest(request.userId)}>
                    Approve
                  </button>
                  <button type="button" onClick={() => rejectJoinRequest(request.userId)}>
                    Deny
                  </button>
                </div>
              </div>
              <div
                className="toast-progress"
                style={{ ["--toast-duration" as string]: `${JOIN_REQUEST_TTL_MS}ms` }}
              />
            </div>
          ))}
        </div>
      ) : null}

      <CallSettingsModal
        open={callSettingsOpen}
        onClose={() => setCallSettingsOpen(false)}
        token={token}
        meetingToJoin={meetingToJoin}
        setMeetingToJoin={setMeetingToJoin}
        autoReconnect={autoReconnect}
        setAutoReconnect={setAutoReconnect}
        devices={devices}
        listDevices={listDevices}
        deviceError={deviceError}
        selectedAudioDeviceId={selectedAudioDeviceId}
        selectedVideoDeviceId={selectedVideoDeviceId}
        setSelectedAudioDeviceId={setSelectedAudioDeviceId}
        setSelectedVideoDeviceId={setSelectedVideoDeviceId}
        applySelectedDevices={applySelectedDevices}
        livekitStatus={livekitStatus}
        livekitError={livekitError}
        livekitParticipantCount={livekitParticipantCount}
        livekitRoomState={livekitRoomState}
        livekitSignalState={livekitSignalState}
        livekitReconnects={livekitReconnects}
        livekitLocalStats={livekitLocalStats}
        livekitLocalAudioStats={livekitLocalAudioStats}
        livekitQuality={livekitQuality}
        livekitUrl={livekitUrl}
        livekitTracks={livekitTracks}
        livekitStats={livekitStats}
        livekitQualityPrefs={livekitQualityPrefs}
        livekitSubscriptions={livekitSubscriptions}
        livekitAudioMuted={livekitAudioMuted}
        updateRemoteQuality={updateRemoteQuality}
        toggleSubscription={toggleSubscription}
        toggleAudioMute={toggleAudioMute}
        roomSnapshot={roomSnapshot}
        roomMuteState={roomMuteState}
        loadRoomState={loadRoomState}
        toggleRoomLock={toggleRoomLock}
        admitUser={admitUser}
        denyUser={denyUser}
        muteUser={muteUser}
        kickUser={kickUser}
        canModerate={canModerate}
      />
    </main>
  );
}

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

function CallSettingsModal({
  open,
  onClose,
  token,
  meetingToJoin,
  setMeetingToJoin,
  autoReconnect,
  setAutoReconnect,
  devices,
  listDevices,
  deviceError,
  selectedAudioDeviceId,
  selectedVideoDeviceId,
  setSelectedAudioDeviceId,
  setSelectedVideoDeviceId,
  applySelectedDevices,
  livekitStatus,
  livekitError,
  livekitParticipantCount,
  livekitRoomState,
  livekitSignalState,
  livekitReconnects,
  livekitLocalStats,
  livekitLocalAudioStats,
  livekitQuality,
  livekitUrl,
  livekitTracks,
  livekitStats,
  livekitQualityPrefs,
  livekitSubscriptions,
  livekitAudioMuted,
  updateRemoteQuality,
  toggleSubscription,
  toggleAudioMute,
  roomSnapshot,
  roomMuteState,
  loadRoomState,
  toggleRoomLock,
  admitUser,
  denyUser,
  muteUser,
  kickUser,
  canModerate,
}: {
  open: boolean;
  onClose: () => void;
  token: string;
  meetingToJoin: string;
  setMeetingToJoin: (value: string) => void;
  autoReconnect: boolean;
  setAutoReconnect: (value: boolean) => void;
  devices: MediaDeviceInfo[];
  listDevices: () => Promise<void>;
  deviceError: string;
  selectedAudioDeviceId: string;
  selectedVideoDeviceId: string;
  setSelectedAudioDeviceId: (value: string) => void;
  setSelectedVideoDeviceId: (value: string) => void;
  applySelectedDevices: () => Promise<void>;
  livekitStatus: string;
  livekitError: string;
  livekitParticipantCount: number;
  livekitRoomState: string;
  livekitSignalState: string;
  livekitReconnects: number;
  livekitLocalStats: StatsSummary | null;
  livekitLocalAudioStats: StatsSummary | null;
  livekitQuality: VideoQuality;
  livekitUrl: string | null;
  livekitTracks: LiveKitTrackItem[];
  livekitStats: Record<string, StatsSummary>;
  livekitQualityPrefs: Record<string, VideoQuality>;
  livekitSubscriptions: Record<string, boolean>;
  livekitAudioMuted: Record<string, boolean>;
  updateRemoteQuality: (item: LiveKitTrackItem, quality: VideoQuality) => void;
  toggleSubscription: (item: LiveKitTrackItem) => void;
  toggleAudioMute: (item: LiveKitTrackItem) => void;
  roomSnapshot: RoomSnapshot | null;
  roomMuteState: Record<string, boolean>;
  loadRoomState: () => Promise<void>;
  toggleRoomLock: () => Promise<void>;
  admitUser: (userId: string) => Promise<void>;
  denyUser: (userId: string) => Promise<void>;
  muteUser: (userId: string) => Promise<void>;
  kickUser: (userId: string) => Promise<void>;
  canModerate: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    void listDevices();
  }, [open, listDevices]);

  if (!open) return null;
  const audioInputs = devices.filter((device) => device.kind === "audioinput");
  const videoInputs = devices.filter((device) => device.kind === "videoinput");
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">Call settings</p>
            <h3>Room controls & stats</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-content">
          <section className="panel">
            <h3>Room</h3>
            <div className="stack">
              <label className="field">
                <span>Meeting ID</span>
                <input value={meetingToJoin} onChange={(e) => setMeetingToJoin(e.target.value)} />
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={autoReconnect} onChange={(e) => setAutoReconnect(e.target.checked)} />
                Auto-reconnect signaling
              </label>
              {!token ? <p className="status error">Authenticate to join calls.</p> : null}
            </div>
          </section>

          <section className="panel">
            <h3>Devices</h3>
            <div className="stack">
              <label className="field">
                <span>Microphone</span>
                <select value={selectedAudioDeviceId} onChange={(e) => setSelectedAudioDeviceId(e.target.value)}>
                  <option value="">Default microphone</option>
                  {audioInputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || "Microphone"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Camera</span>
                <select value={selectedVideoDeviceId} onChange={(e) => setSelectedVideoDeviceId(e.target.value)}>
                  <option value="">Default camera</option>
                  {videoInputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || "Camera"}
                    </option>
                  ))}
                </select>
              </label>
              {deviceError ? <p className="status error">{deviceError}</p> : null}
              <div className="row">
                <button type="button" onClick={listDevices}>
                  Refresh devices
                </button>
                <button type="button" onClick={applySelectedDevices}>
                  Apply devices
                </button>
              </div>
            </div>
          </section>

          <section className="panel">
            <h3>LiveKit</h3>
            <div className="stack">
              <p className="status">Status: {livekitStatus}</p>
              {livekitError ? <p className="status error">{livekitError}</p> : null}
              <p className="hint">Participants: {livekitParticipantCount}</p>
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
            </div>
          </section>

          <section className="panel">
            <h3>Participants</h3>
            <div className="tiles">
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
          </section>

          {canModerate ? (
            <section className="panel">
              <h3>Moderation</h3>
              <div className="stack">
                <div className="row">
                  <button type="button" onClick={loadRoomState} disabled={!meetingToJoin || !token}>
                    Refresh lobby
                  </button>
                  <button type="button" onClick={toggleRoomLock} disabled={!roomSnapshot}>
                    {roomSnapshot?.locked ? "Unlock room" : "Lock room"}
                  </button>
                </div>
                <p className="hint">Locked: {roomSnapshot?.locked ? "yes" : "no"}</p>
                <div className="tiles moderation-grid">
                  <div className="tile">
                    <div className="tile-header">
                      <strong>Lobby</strong>
                      <span className="badge warn">{roomSnapshot?.lobby.length ?? 0}</span>
                    </div>
                    {roomSnapshot?.lobby.map((entry) => (
                      <div key={entry.userId} className="list-item">
                        <div>
                          <strong>{entry.name || entry.userId}</strong>
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
                          <strong>{entry.name || entry.userId}</strong>
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
          ) : null}
        </div>
      </div>
    </div>
  );
}

function LiveKitFocusTile({
  item,
  isSpeaking,
}: {
  item: LiveKitTrackItem;
  isSpeaking: boolean;
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
  return (
    <div className={`focus-tile${isSpeaking ? " speaking" : ""}`}>
      <div className="tile-header">
        <strong>{title}</strong>
        {isSpeaking ? <span className="badge ok">Speaking</span> : <span className="badge">{item.kind}</span>}
      </div>
      {item.kind === "video" ? (
        <video ref={ref as RefObject<HTMLVideoElement>} autoPlay playsInline className="focus-video" />
      ) : (
        <>
          <div className="focus-placeholder">{title}</div>
          <audio ref={ref as RefObject<HTMLAudioElement>} autoPlay />
        </>
      )}
    </div>
  );
}

function LiveKitSideTile({
  item,
  isSpeaking,
}: {
  item: LiveKitTrackItem;
  isSpeaking: boolean;
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
  return (
    <div className={`side-tile${isSpeaking ? " speaking" : ""}`}>
      <div className="tile-header">
        <strong>{title}</strong>
        {isSpeaking ? <span className="badge ok">Speaking</span> : null}
      </div>
      {item.kind === "video" ? (
        <video ref={ref as RefObject<HTMLVideoElement>} autoPlay playsInline className="side-video" />
      ) : (
        <>
          <div className="side-placeholder">{title}</div>
          <audio ref={ref as RefObject<HTMLAudioElement>} autoPlay />
        </>
      )}
    </div>
  );
}

function FocusPlaceholder({ name }: { name: string }) {
  return (
    <div className="focus-tile">
      <div className="tile-header">
        <strong>{name}</strong>
      </div>
      <div className="focus-placeholder">{name}</div>
    </div>
  );
}

function SidePlaceholder({ name }: { name: string }) {
  return (
    <div className="side-tile">
      <div className="tile-header">
        <strong>{name}</strong>
      </div>
      <div className="side-placeholder">{name}</div>
    </div>
  );
}
