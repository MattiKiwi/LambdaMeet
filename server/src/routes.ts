import express, { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { env } from "./config.js";
import { signToken, verifyPassword, verifyToken, devLogin, redeemInvite, AuthTokenPayload } from "./auth.js";
import { createInvite, createMeeting, findMeeting, findUserByEmail, listMeetingsForUser, seedAdmin } from "./store.js";
import { actionFailure, actionStart, actionSuccess, auditLog, withComponent } from "./logger.js";
import { Role } from "./types.js";
import { getTurnConfig } from "./turn.js";
import { createLiveKitToken, getLiveKitConfig, updateLiveKitRoomMetadata } from "./livekit.js";
import {
  admitLobbyUser,
  denyLobbyUser,
  getRoomSnapshot,
  kickParticipant,
  listLobby,
  listParticipants,
  muteParticipant,
  setRoomLock,
} from "./signaling.js";

type AuthenticatedRequest = Request & { user?: AuthTokenPayload };

const meetingSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  recurrence: z.string().optional(),
  policy: z
    .object({
      lobbyRequired: z.boolean().default(true),
      recordingAllowed: z.boolean().default(false),
      screenShareAllowed: z.boolean().default(true),
      maxParticipants: z.number().int().positive().optional(),
    })
    .default({ lobbyRequired: true, recordingAllowed: false, screenShareAllowed: true }),
}).refine((data) => new Date(data.endTime).getTime() > new Date(data.startTime).getTime(), {
  path: ["endTime"],
  message: "endTime must be after startTime",
});

const router = express.Router();
const log = withComponent("api");

router.get("/health", (_req, res) => {
  actionStart("api", "health");
  res.json({ status: "ok" });
  actionSuccess("api", "health");
});

router.get("/config", (_req, res) => {
  actionStart("api", "config");
  const turn = getTurnConfig(env);
  const livekit = getLiveKitConfig(env);
  res.json({ turn, livekit: { url: livekit.url } });
  actionSuccess("api", "config", { turnEnabled: Boolean(turn), livekitEnabled: Boolean(livekit.url) });
});

router.get("/me", requireAuth, async (req: AuthenticatedRequest, res) => {
  actionStart("api", "me", { userId: req.user?.sub });
  res.json({ user: req.user });
  actionSuccess("api", "me", { userId: req.user?.sub });
});

router.post("/auth/login", express.json(), async (req: Request, res: Response) => {
  actionStart("api", "auth.login", { email: req.body?.email });
  const bodySchema = z.object({
    email: z.string().email(),
    password: z.string().optional(),
    role: z.enum(["admin", "user"]).optional(),
  });
  const parse = bodySchema.safeParse(req.body);
  if (!parse.success) {
    actionFailure("api", "auth.login", { reason: "validation" });
    return res.status(400).json({ error: parse.error.flatten() });
  }

  const { email, password, role } = parse.data;
  const user = await seedAndFetchUser(email, role);
  if (!user) {
    actionFailure("api", "auth.login", { reason: "no_user", email });
    return res.status(401).json({ error: "Invalid credentials" });
  }
  if (password && !verifyPassword(password, user.passwordHash || undefined)) {
    actionFailure("api", "auth.login", { reason: "invalid_password", userId: user.id });
    return res.status(401).json({ error: "Invalid credentials" });
  }
  if (!password && !env.devAuthEnabled) {
    actionFailure("api", "auth.login", { reason: "password_required", userId: user.id });
    return res.status(401).json({ error: "Password required" });
  }
  const token = signToken(user);
  log.debug({ step: "auth.login", userId: user.id, role: user.role }, "Login success");
  res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  actionSuccess("api", "auth.login", { userId: user.id, role: user.role });
});

router.post("/auth/guest", express.json(), async (req: Request, res: Response) => {
  actionStart("api", "auth.guest", { inviteToken: req.body?.inviteToken });
  const bodySchema = z.object({
    inviteToken: z.string(),
    email: z.string().email().optional(),
  });
  const parse = bodySchema.safeParse(req.body);
  if (!parse.success) {
    actionFailure("api", "auth.guest", { reason: "validation" });
    return res.status(400).json({ error: parse.error.flatten() });
  }
  const invite = await redeemInvite(parse.data.inviteToken);
  if (!invite) {
    actionFailure("api", "auth.guest", { reason: "invalid_invite" });
    return res.status(400).json({ error: "Invalid or expired invite" });
  }
  const email = parse.data.email || `guest-${invite.token}@example.invalid`;
  const user = await seedAndFetchUser(email, invite.role);
  if (!user) {
    actionFailure("api", "auth.guest", { reason: "disabled", meetingId: invite.meetingId });
    return res.status(401).json({ error: "Guest login disabled" });
  }
  const token = signToken(user);
  log.debug({ step: "auth.guest", meetingId: invite.meetingId, userId: user.id }, "Guest token issued");
  res.json({ token, role: invite.role, meetingId: invite.meetingId });
  actionSuccess("api", "auth.guest", { meetingId: invite.meetingId, userId: user.id });
});

router.post("/meetings", requireAuth, express.json(), async (req: AuthenticatedRequest, res: Response) => {
  actionStart("api", "meeting.create", { userId: req.user?.sub });
  const parsed = meetingSchema.safeParse(req.body);
  if (!parsed.success) {
    actionFailure("api", "meeting.create", { reason: "validation", userId: req.user?.sub });
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const body = parsed.data;
  const meeting = await createMeeting({
    hostId: req.user!.sub,
    title: body.title,
    description: body.description,
    startTime: new Date(body.startTime),
    endTime: new Date(body.endTime),
    recurrence: body.recurrence,
    policy: body.policy,
  });
  log.debug({ step: "meeting.create", meetingId: meeting.id, hostId: meeting.hostId }, "Meeting created");
  res.status(201).json({ meeting });
  actionSuccess("api", "meeting.create", { meetingId: meeting.id, hostId: meeting.hostId });
});

router.get("/meetings", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  actionStart("api", "meeting.list", { userId: req.user?.sub });
  const list = await listMeetingsForUser(req.user!.sub);
  log.debug({ step: "meeting.list", userId: req.user!.sub, count: list.length }, "Meetings listed");
  res.json({ meetings: list });
  actionSuccess("api", "meeting.list", { userId: req.user?.sub, count: list.length });
});

router.post("/meetings/:id/invites", requireAuth, express.json(), async (req: AuthenticatedRequest, res: Response) => {
  actionStart("api", "invite.create", { userId: req.user?.sub, meetingId: req.params.id });
  const meeting = await findMeeting(req.params.id);
  if (!meeting) {
    actionFailure("api", "invite.create", { reason: "meeting_not_found", meetingId: req.params.id });
    return res.status(404).json({ error: "Not found" });
  }
  if (meeting.hostId !== req.user!.sub && req.user!.role !== "admin") {
    actionFailure("api", "invite.create", { reason: "forbidden", meetingId: meeting.id });
    return res.status(403).json({ error: "Forbidden" });
  }
  const bodySchema = z.object({
    role: z.enum(["guest", "user"]).default("guest"),
    email: z.string().email().optional(),
    expiresInMinutes: z.number().int().positive().max(24 * 60).default(120),
  });
  const parse = bodySchema.safeParse(req.body);
  if (!parse.success) {
    actionFailure("api", "invite.create", { reason: "validation", meetingId: meeting.id });
    return res.status(400).json({ error: parse.error.flatten() });
  }
  const invite = await createInvite(meeting.id, parse.data.role as Role, parse.data.email, parse.data.expiresInMinutes);
  log.debug({ step: "invite.create", meetingId: meeting.id, inviteId: invite.id, role: invite.role }, "Invite created");
  res.status(201).json({ invite });
  actionSuccess("api", "invite.create", { meetingId: meeting.id, inviteId: invite.id, role: invite.role });
});

router.get("/meetings/:id/state", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  actionStart("api", "meeting.state", { meetingId: req.params.id, userId: req.user?.sub });
  const meeting = await findMeeting(req.params.id);
  if (!meeting) {
    actionFailure("api", "meeting.state", { reason: "meeting_not_found", meetingId: req.params.id });
    return res.status(404).json({ error: "Not found" });
  }
  if (meeting.hostId !== req.user!.sub && req.user!.role !== "admin") {
    actionFailure("api", "meeting.state", { reason: "forbidden", meetingId: meeting.id });
    return res.status(403).json({ error: "Forbidden" });
  }
  const snapshot = getRoomSnapshot(meeting.id);
  actionSuccess("api", "meeting.state", { meetingId: meeting.id });
  res.json(snapshot);
});

router.get("/meetings/:id/lobby", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  actionStart("api", "meeting.lobby", { meetingId: req.params.id, userId: req.user?.sub });
  const meeting = await findMeeting(req.params.id);
  if (!meeting) {
    actionFailure("api", "meeting.lobby", { reason: "meeting_not_found", meetingId: req.params.id });
    return res.status(404).json({ error: "Not found" });
  }
  if (meeting.hostId !== req.user!.sub && req.user!.role !== "admin") {
    actionFailure("api", "meeting.lobby", { reason: "forbidden", meetingId: meeting.id });
    return res.status(403).json({ error: "Forbidden" });
  }
  const lobby = listLobby(meeting.id);
  actionSuccess("api", "meeting.lobby", { meetingId: meeting.id, count: lobby.length });
  res.json({ lobby });
});

router.get("/meetings/:id/participants", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  actionStart("api", "meeting.participants", { meetingId: req.params.id, userId: req.user?.sub });
  const meeting = await findMeeting(req.params.id);
  if (!meeting) {
    actionFailure("api", "meeting.participants", { reason: "meeting_not_found", meetingId: req.params.id });
    return res.status(404).json({ error: "Not found" });
  }
  if (meeting.hostId !== req.user!.sub && req.user!.role !== "admin") {
    actionFailure("api", "meeting.participants", { reason: "forbidden", meetingId: meeting.id });
    return res.status(403).json({ error: "Forbidden" });
  }
  const participants = listParticipants(meeting.id);
  actionSuccess("api", "meeting.participants", { meetingId: meeting.id, count: participants.length });
  res.json({ participants });
});

router.post("/meetings/:id/lock", requireAuth, express.json(), async (req: AuthenticatedRequest, res: Response) => {
  actionStart("api", "meeting.lock", { meetingId: req.params.id, userId: req.user?.sub });
  const meeting = await findMeeting(req.params.id);
  if (!meeting) {
    actionFailure("api", "meeting.lock", { reason: "meeting_not_found", meetingId: req.params.id });
    return res.status(404).json({ error: "Not found" });
  }
  if (meeting.hostId !== req.user!.sub && req.user!.role !== "admin") {
    actionFailure("api", "meeting.lock", { reason: "forbidden", meetingId: meeting.id });
    return res.status(403).json({ error: "Forbidden" });
  }
  const bodySchema = z.object({ locked: z.boolean() });
  const parse = bodySchema.safeParse(req.body);
  if (!parse.success) {
    actionFailure("api", "meeting.lock", { reason: "validation", meetingId: meeting.id });
    return res.status(400).json({ error: parse.error.flatten() });
  }
  const locked = setRoomLock(meeting.id, parse.data.locked);
  const snapshot = getRoomSnapshot(meeting.id);
  await updateLiveKitRoomMetadata(getLiveKitConfig(env), meeting.id, snapshot);
  auditLog("meeting.lock", req.user!.sub, meeting.id, { locked });
  actionSuccess("api", "meeting.lock", { meetingId: meeting.id, locked });
  res.json({ locked });
});

router.post("/meetings/:id/admit", requireAuth, express.json(), async (req: AuthenticatedRequest, res: Response) => {
  actionStart("api", "meeting.admit", { meetingId: req.params.id, userId: req.user?.sub });
  const meeting = await findMeeting(req.params.id);
  if (!meeting) {
    actionFailure("api", "meeting.admit", { reason: "meeting_not_found", meetingId: req.params.id });
    return res.status(404).json({ error: "Not found" });
  }
  if (meeting.hostId !== req.user!.sub && req.user!.role !== "admin") {
    actionFailure("api", "meeting.admit", { reason: "forbidden", meetingId: meeting.id });
    return res.status(403).json({ error: "Forbidden" });
  }
  const bodySchema = z.object({ userId: z.string().min(1) });
  const parse = bodySchema.safeParse(req.body);
  if (!parse.success) {
    actionFailure("api", "meeting.admit", { reason: "validation", meetingId: meeting.id });
    return res.status(400).json({ error: parse.error.flatten() });
  }
  const ok = admitLobbyUser(meeting.id, parse.data.userId);
  if (ok) {
    auditLog("meeting.admit", req.user!.sub, parse.data.userId, { meetingId: meeting.id });
  }
  actionSuccess("api", "meeting.admit", { meetingId: meeting.id, admitted: ok });
  res.json({ admitted: ok });
});

router.post("/meetings/:id/deny", requireAuth, express.json(), async (req: AuthenticatedRequest, res: Response) => {
  actionStart("api", "meeting.deny", { meetingId: req.params.id, userId: req.user?.sub });
  const meeting = await findMeeting(req.params.id);
  if (!meeting) {
    actionFailure("api", "meeting.deny", { reason: "meeting_not_found", meetingId: req.params.id });
    return res.status(404).json({ error: "Not found" });
  }
  if (meeting.hostId !== req.user!.sub && req.user!.role !== "admin") {
    actionFailure("api", "meeting.deny", { reason: "forbidden", meetingId: meeting.id });
    return res.status(403).json({ error: "Forbidden" });
  }
  const bodySchema = z.object({ userId: z.string().min(1) });
  const parse = bodySchema.safeParse(req.body);
  if (!parse.success) {
    actionFailure("api", "meeting.deny", { reason: "validation", meetingId: meeting.id });
    return res.status(400).json({ error: parse.error.flatten() });
  }
  const ok = denyLobbyUser(meeting.id, parse.data.userId);
  if (ok) {
    auditLog("meeting.deny", req.user!.sub, parse.data.userId, { meetingId: meeting.id });
  }
  actionSuccess("api", "meeting.deny", { meetingId: meeting.id, denied: ok });
  res.json({ denied: ok });
});

router.post("/meetings/:id/kick", requireAuth, express.json(), async (req: AuthenticatedRequest, res: Response) => {
  actionStart("api", "meeting.kick", { meetingId: req.params.id, userId: req.user?.sub });
  const meeting = await findMeeting(req.params.id);
  if (!meeting) {
    actionFailure("api", "meeting.kick", { reason: "meeting_not_found", meetingId: req.params.id });
    return res.status(404).json({ error: "Not found" });
  }
  if (meeting.hostId !== req.user!.sub && req.user!.role !== "admin") {
    actionFailure("api", "meeting.kick", { reason: "forbidden", meetingId: meeting.id });
    return res.status(403).json({ error: "Forbidden" });
  }
  const bodySchema = z.object({ userId: z.string().min(1) });
  const parse = bodySchema.safeParse(req.body);
  if (!parse.success) {
    actionFailure("api", "meeting.kick", { reason: "validation", meetingId: meeting.id });
    return res.status(400).json({ error: parse.error.flatten() });
  }
  const ok = kickParticipant(meeting.id, parse.data.userId);
  if (ok) {
    auditLog("meeting.kick", req.user!.sub, parse.data.userId, { meetingId: meeting.id });
  }
  actionSuccess("api", "meeting.kick", { meetingId: meeting.id, kicked: ok });
  res.json({ kicked: ok });
});

router.post("/meetings/:id/mute", requireAuth, express.json(), async (req: AuthenticatedRequest, res: Response) => {
  actionStart("api", "meeting.mute", { meetingId: req.params.id, userId: req.user?.sub });
  const meeting = await findMeeting(req.params.id);
  if (!meeting) {
    actionFailure("api", "meeting.mute", { reason: "meeting_not_found", meetingId: req.params.id });
    return res.status(404).json({ error: "Not found" });
  }
  if (meeting.hostId !== req.user!.sub && req.user!.role !== "admin") {
    actionFailure("api", "meeting.mute", { reason: "forbidden", meetingId: meeting.id });
    return res.status(403).json({ error: "Forbidden" });
  }
  const bodySchema = z.object({ userId: z.string().min(1), muted: z.boolean() });
  const parse = bodySchema.safeParse(req.body);
  if (!parse.success) {
    actionFailure("api", "meeting.mute", { reason: "validation", meetingId: meeting.id });
    return res.status(400).json({ error: parse.error.flatten() });
  }
  const ok = muteParticipant(meeting.id, parse.data.userId, parse.data.muted);
  if (ok) {
    auditLog("meeting.mute", req.user!.sub, parse.data.userId, { meetingId: meeting.id, muted: parse.data.muted });
  }
  actionSuccess("api", "meeting.mute", { meetingId: meeting.id, muted: parse.data.muted });
  res.json({ muted: ok });
});

router.post("/livekit/token", requireAuth, express.json(), async (req: AuthenticatedRequest, res: Response) => {
  actionStart("api", "livekit.token", { userId: req.user?.sub });
  const bodySchema = z.object({
    room: z.string().min(1),
  });
  const parse = bodySchema.safeParse(req.body);
  if (!parse.success) {
    actionFailure("api", "livekit.token", { reason: "validation" });
    return res.status(400).json({ error: parse.error.flatten() });
  }
  try {
    const config = getLiveKitConfig(env);
    const token = await createLiveKitToken(config, parse.data.room, req.user!.sub, req.user!.email);
    actionSuccess("api", "livekit.token", { room: parse.data.room, userId: req.user!.sub });
    return res.json({ token, url: config.url });
  } catch (err) {
    actionFailure("api", "livekit.token", { reason: "missing_config" });
    return res.status(500).json({ error: (err as Error).message });
  }
});

async function seedAndFetchUser(email: string, role: Role = "user") {
  const existing = await findUserByEmail(email);
  if (existing) return existing;
  if (role === "admin") {
    const admin = await seedAdmin(email, undefined);
    return admin;
  }
  if (!env.devAuthEnabled) return null;
  return devLogin(email, role);
}

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) {
    actionFailure("api", "auth.require", { reason: "missing_token" });
    return res.status(401).json({ error: "Missing token" });
  }
  const payload = verifyToken(token);
  if (!payload) {
    actionFailure("api", "auth.require", { reason: "invalid_token" });
    return res.status(401).json({ error: "Invalid token" });
  }
  req.user = payload;
  actionSuccess("api", "auth.require", { userId: payload.sub });
  next();
}

export default router;
