export type Role = "admin" | "user" | "guest";

export type User = {
  id: string;
  email: string;
  role: Role;
  passwordHash?: string;
  createdAt: Date;
};

export type MeetingPolicy = {
  lobbyRequired: boolean;
  recordingAllowed: boolean;
  screenShareAllowed: boolean;
  maxParticipants?: number;
};

export type Meeting = {
  id: string;
  orgId?: string;
  hostId: string;
  title: string;
  description?: string;
  startTime: Date;
  endTime: Date;
  recurrence?: string;
  policy: MeetingPolicy;
  createdAt: Date;
  updatedAt: Date;
};

export type Invite = {
  id: string;
  meetingId: string;
  email?: string;
  role: Role;
  token: string;
  expiresAt: Date;
  createdAt: Date;
};

export type RoomParticipant = {
  userId: string;
  meetingId: string;
  role: Role;
  socketId: string;
};
