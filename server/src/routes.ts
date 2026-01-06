import express, { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { env } from "./config.js";
import { signToken, verifyPassword, verifyToken, devLogin, redeemInvite, AuthTokenPayload } from "./auth.js";
import { createInvite, createMeeting, findMeeting, findUserByEmail, listMeetingsForUser, seedAdmin } from "./store.js";
import { withComponent } from "./logger.js";
import { Role } from "./types.js";

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
  log.debug({ step: "health" }, "Health check");
  res.json({ status: "ok" });
});

router.get("/me", requireAuth, async (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user });
});

router.post("/auth/login", express.json(), async (req: Request, res: Response) => {
  const bodySchema = z.object({
    email: z.string().email(),
    password: z.string().optional(),
    role: z.enum(["admin", "user"]).optional(),
  });
  const parse = bodySchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.flatten() });

  const { email, password, role } = parse.data;
  const user = await seedAndFetchUser(email, role);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  if (password && !verifyPassword(password, user.passwordHash || undefined)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  if (!password && !env.devAuthEnabled) {
    return res.status(401).json({ error: "Password required" });
  }
  const token = signToken(user);
  log.debug({ step: "auth.login", userId: user.id, role: user.role }, "Login success");
  res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
});

router.post("/auth/guest", express.json(), async (req: Request, res: Response) => {
  const bodySchema = z.object({
    inviteToken: z.string(),
    email: z.string().email().optional(),
  });
  const parse = bodySchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.flatten() });
  const invite = await redeemInvite(parse.data.inviteToken);
  if (!invite) return res.status(400).json({ error: "Invalid or expired invite" });
  const email = parse.data.email || `guest-${invite.token}@example.invalid`;
  const user = await seedAndFetchUser(email, invite.role);
  if (!user) return res.status(401).json({ error: "Guest login disabled" });
  const token = signToken(user);
  log.debug({ step: "auth.guest", meetingId: invite.meetingId, userId: user.id }, "Guest token issued");
  res.json({ token, role: invite.role, meetingId: invite.meetingId });
});

router.post("/meetings", requireAuth, express.json(), async (req: AuthenticatedRequest, res: Response) => {
  const parsed = meetingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
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
});

router.get("/meetings", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const list = await listMeetingsForUser(req.user!.sub);
  log.debug({ step: "meeting.list", userId: req.user!.sub, count: list.length }, "Meetings listed");
  res.json({ meetings: list });
});

router.post("/meetings/:id/invites", requireAuth, express.json(), async (req: AuthenticatedRequest, res: Response) => {
  const meeting = await findMeeting(req.params.id);
  if (!meeting) return res.status(404).json({ error: "Not found" });
  if (meeting.hostId !== req.user!.sub && req.user!.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  const bodySchema = z.object({
    role: z.enum(["guest", "user"]).default("guest"),
    email: z.string().email().optional(),
    expiresInMinutes: z.number().int().positive().max(24 * 60).default(120),
  });
  const parse = bodySchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.flatten() });
  const invite = await createInvite(meeting.id, parse.data.role as Role, parse.data.email, parse.data.expiresInMinutes);
  log.debug({ step: "invite.create", meetingId: meeting.id, inviteId: invite.id, role: invite.role }, "Invite created");
  res.status(201).json({ invite });
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
  if (!token) return res.status(401).json({ error: "Missing token" });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Invalid token" });
  req.user = payload;
  next();
}

export default router;
