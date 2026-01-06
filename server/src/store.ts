import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { prisma } from "./db.js";
import { Prisma } from "@prisma/client";
import { addMinutes } from "./time.js";
import { Role } from "./types.js";

export async function seedAdmin(email: string, password?: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  const passwordHash = password ? bcrypt.hashSync(password, 10) : undefined;
  return prisma.user.create({
    data: { email, role: "admin", passwordHash },
  });
}

export async function createUser(email: string, role: Role, password?: string) {
  const passwordHash = password ? bcrypt.hashSync(password, 10) : undefined;
  return prisma.user.create({
    data: { email, role, passwordHash },
  });
}

export async function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

export async function findUser(id: string) {
  return prisma.user.findUnique({ where: { id } });
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
  return prisma.meeting.create({
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
}

export async function listMeetingsForUser(userId: string) {
  return prisma.meeting.findMany({
    where: { hostId: userId },
    orderBy: { startTime: "asc" },
  });
}

export async function findMeeting(id: string) {
  return prisma.meeting.findUnique({ where: { id } });
}

export async function createInvite(meetingId: string, role: Role, email?: string, ttlMinutes = 120) {
  const token = randomUUID();
  const expiresAt = addMinutes(new Date(), ttlMinutes);
  return prisma.invite.create({
    data: {
      meetingId,
      role,
      email,
      token,
      expiresAt,
    },
  });
}

export async function findInviteByToken(token: string) {
  return prisma.invite.findFirst({
    where: {
      token,
      expiresAt: { gt: new Date() },
    },
  });
}
