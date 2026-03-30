import type { JWTPayload } from "jose";

export type Role = string;
export type Permission = string;

export type AuthContext = {
  claims: JWTPayload & Record<string, unknown>;
  permissions: Permission[];
  roles: Role[];
  sessionId: string | null;
  token: string;
  userId: string;
};
