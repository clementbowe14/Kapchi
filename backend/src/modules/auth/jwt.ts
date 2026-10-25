import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../../config/index.js";
import type { AuthContext } from "../../types/auth.js";
import { normalizePermissions, normalizeStoreRoles } from "./claims.js";

const jwks = createRemoteJWKSet(new URL(config.auth.clerk.jwksUrl));

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
    roles: normalizeStoreRoles(payload as Record<string, unknown>),
    sessionId: typeof payload.sid === "string" ? payload.sid : null,
    token,
    userId
  };
}
