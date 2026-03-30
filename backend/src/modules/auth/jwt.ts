import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../../config/index.js";
import type { AuthContext, Permission, Role } from "../../types/auth.js";

const jwks = createRemoteJWKSet(new URL(config.auth.clerk.jwksUrl));

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value === "string" && value.length > 0) {
    return [value];
  }

  return [];
}

function normalizeRoles(claims: Record<string, unknown>): Role[] {
  return Array.from(
    new Set([
      ...readStringArray(claims.roles),
      ...readStringArray(claims.role),
      ...readStringArray((claims.metadata as Record<string, unknown> | undefined)?.roles),
      ...readStringArray((claims.public_metadata as Record<string, unknown> | undefined)?.roles),
      ...readStringArray(claims.org_role)
    ]),
  );
}

function normalizePermissions(claims: Record<string, unknown>): Permission[] {
  return Array.from(
    new Set([
      ...readStringArray(claims.permissions),
      ...readStringArray(
        (claims.metadata as Record<string, unknown> | undefined)?.permissions,
      ),
      ...readStringArray(
        (claims.public_metadata as Record<string, unknown> | undefined)?.permissions,
      )
    ]),
  );
}

export async function verifyClerkToken(token: string): Promise<AuthContext> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: config.auth.clerk.jwtIssuer
  });

  const userId =
    typeof payload.sub === "string" ? payload.sub : typeof payload.user_id === "string" ? payload.user_id : null;

  if (!userId) {
    throw new Error("Verified Clerk token is missing a subject claim.");
  }

  return {
    claims: payload as AuthContext["claims"],
    permissions: normalizePermissions(payload as Record<string, unknown>),
    roles: normalizeRoles(payload as Record<string, unknown>),
    sessionId: typeof payload.sid === "string" ? payload.sid : null,
    token,
    userId
  };
}
