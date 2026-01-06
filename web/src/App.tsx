import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

type Meeting = {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  policy: { lobbyRequired: boolean };
};

type User = { id: string; email: string; role: string };

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
  const [inviteMeetingId, setInviteMeetingId] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("guest");
  const [inviteResult, setInviteResult] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [meetingToJoin, setMeetingToJoin] = useState("");
  const [wsStatus, setWsStatus] = useState("disconnected");
  const [wsMessages, setWsMessages] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const api = useMemo(() => apiClient(apiBase, token), [apiBase, token]);

  useEffect(() => {
    if (!token) return;
    loadMeetings();
  }, [token]);

  async function loadMeetings() {
    const res = await api.get("/meetings");
    if (res.ok) {
      setMeetings(res.data.meetings);
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

  function connectSignaling(e: FormEvent) {
    e.preventDefault();
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
    socket.onopen = () => setWsStatus("connected");
    socket.onclose = () => setWsStatus("disconnected");
    socket.onerror = () => setWsStatus("error");
    socket.onmessage = (evt) => {
      setWsMessages((prev) => [evt.data as string, ...prev].slice(0, 10));
    };
  }

  function disconnectSocket() {
    wsRef.current?.close();
    wsRef.current = null;
  }

  function sendSignal(message: string) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(message);
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
            <button type="button" onClick={() => sendSignal(JSON.stringify({ type: "ping", at: Date.now() }))}>
              Send ping
            </button>
          </form>
          <div className="list">
            {wsMessages.map((m, idx) => (
              <div key={idx} className="list-item">
                <code>{m}</code>
              </div>
            ))}
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

function buildWsUrl(apiBase: string, token: string, meetingId: string) {
  const wsBase = apiBase.replace(/^http/, "ws").replace(/\/$/, "");
  const url = new URL(wsBase + "/ws");
  url.searchParams.set("token", token);
  url.searchParams.set("meetingId", meetingId);
  return url.toString();
}

export default App;
