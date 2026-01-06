import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { env } from "./config.js";
import { Role } from "./types.js";
import { createUser, findInviteByToken, findUserByEmail } from "./store.js";

export type AuthTokenPayload = {
  sub: string;
  email: string;
  role: Role;
};

type TokenSubject = { id: string; email: string; role: Role };

export function signToken(user: TokenSubject) {
  const payload: AuthTokenPayload = { sub: user.id, email: user.email, role: user.role };
  return jwt.sign(payload, env.jwtSecret, { expiresIn: "2h" });
}

export function verifyToken(token: string): AuthTokenPayload | null {
  try {
    return jwt.verify(token, env.jwtSecret) as AuthTokenPayload;
  } catch {
    return null;
  }
}

export function verifyPassword(password: string, hash?: string): boolean {
  if (!hash) return false;
  return bcrypt.compareSync(password, hash);
}

export async function redeemInvite(token: string) {
  const invite = await findInviteByToken(token);
  if (!invite) return null;
  return invite;
}

export async function devLogin(email: string, role: Role = "user") {
  const existing = await findUserByEmail(email);
  if (existing) return existing;
  return createUser(email, role);
}
