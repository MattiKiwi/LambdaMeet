import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { prisma } from "./db.js";
import { Prisma } from "@prisma/client";
import { addMinutes } from "./time.js";
import { Role } from "./types.js";
import { actionStart, actionSuccess } from "./logger.js";

export async function seedAdmin(email: string, password?: string) {
  actionStart("store", "user.seed_admin", { email });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    actionSuccess("store", "user.seed_admin", { email, userId: existing.id });
    return existing;
  }
  const passwordHash = password ? bcrypt.hashSync(password, 10) : undefined;
  const user = await prisma.user.create({
    data: { email, role: "admin", passwordHash },
  });
  actionSuccess("store", "user.seed_admin", { email, userId: user.id });
  return user;
}

export async function createUser(email: string, role: Role, password?: string, fullName?: string) {
  actionStart("store", "user.create", { email, role });
  const passwordHash = password ? bcrypt.hashSync(password, 10) : undefined;
  const user = await prisma.user.create({
    data: { email, role, passwordHash, fullName },
  });
  actionSuccess("store", "user.create", { userId: user.id, role: user.role });
  return user;
}

export async function findUserByEmail(email: string) {
  actionStart("store", "user.find_by_email", { email });
  const user = await prisma.user.findUnique({ where: { email } });
  actionSuccess("store", "user.find_by_email", { email, found: Boolean(user) });
  return user;
}

export async function findUser(id: string) {
  actionStart("store", "user.find_by_id", { userId: id });
  const user = await prisma.user.findUnique({ where: { id } });
  actionSuccess("store", "user.find_by_id", { userId: id, found: Boolean(user) });
  return user;
}

export async function listUsers() {
  actionStart("store", "user.list");
  const users = await prisma.user.findMany({ orderBy: { createdAt: "desc" } });
  actionSuccess("store", "user.list", { count: users.length });
  return users;
}

export async function updateUser(
  id: string,
  input: { email?: string; role?: Role; fullName?: string | null; password?: string },
) {
  actionStart("store", "user.update", { userId: id });
  const passwordHash = input.password ? bcrypt.hashSync(input.password, 10) : undefined;
  const user = await prisma.user.update({
    where: { id },
    data: {
      email: input.email,
      role: input.role,
      fullName: input.fullName,
      ...(passwordHash ? { passwordHash } : {}),
    },
  });
  actionSuccess("store", "user.update", { userId: user.id, role: user.role });
  return user;
}

export async function deleteUser(id: string, options?: { force?: boolean }) {
  actionStart("store", "user.delete", { userId: id });
  const meetings = await prisma.meeting.count({ where: { hostId: id } });
  if (meetings > 0 && !options?.force) {
    actionSuccess("store", "user.delete", { userId: id, deleted: false, reason: "user_has_meetings" });
    return { deleted: false, reason: "user_has_meetings" as const };
  }
  await prisma.$transaction(async (tx) => {
    await tx.invite.deleteMany({ where: { meeting: { hostId: id } } });
    await tx.meeting.deleteMany({ where: { hostId: id } });
    await tx.invite.updateMany({ where: { userId: id }, data: { userId: null } });
    await tx.user.delete({ where: { id } });
  });
  actionSuccess("store", "user.delete", { userId: id, deleted: true });
  return { deleted: true as const };
}

export async function createMeeting(input: {
  hostId: string;
  title: string;
  description?: string;
  startTime: Date;
  endTime: Date;
  recurrence?: string;
  policy: Prisma.InputJsonValue;
}) {
  actionStart("store", "meeting.create", { hostId: input.hostId });
  const meeting = await prisma.meeting.create({
    data: {
      hostId: input.hostId,
      title: input.title,
      description: input.description,
      startTime: input.startTime,
      endTime: input.endTime,
      recurrence: input.recurrence,
      policyJson: input.policy,
    },
  });
  actionSuccess("store", "meeting.create", { meetingId: meeting.id, hostId: meeting.hostId });
  return meeting;
}

export async function listMeetingsForUser(userId: string) {
  actionStart("store", "meeting.list", { userId });
  const meetings = await prisma.meeting.findMany({
    where: { hostId: userId },
    orderBy: { startTime: "asc" },
  });
  actionSuccess("store", "meeting.list", { userId, count: meetings.length });
  return meetings;
}

export async function findMeeting(id: string) {
  actionStart("store", "meeting.find", { meetingId: id });
  const meeting = await prisma.meeting.findUnique({ where: { id } });
  actionSuccess("store", "meeting.find", { meetingId: id, found: Boolean(meeting) });
  return meeting;
}

export async function createInvite(meetingId: string, role: Role, email?: string, ttlMinutes = 120) {
  actionStart("store", "invite.create", { meetingId, role });
  const token = randomUUID();
  const expiresAt = addMinutes(new Date(), ttlMinutes);
  const invite = await prisma.invite.create({
    data: {
      meetingId,
      role,
      email,
      token,
      expiresAt,
    },
  });
  actionSuccess("store", "invite.create", { inviteId: invite.id, meetingId: invite.meetingId });
  return invite;
}

export async function findInviteByToken(token: string) {
  actionStart("store", "invite.find_by_token", { token });
  const invite = await prisma.invite.findFirst({
    where: {
      token,
      expiresAt: { gt: new Date() },
    },
  });
  actionSuccess("store", "invite.find_by_token", { found: Boolean(invite) });
  return invite;
}
