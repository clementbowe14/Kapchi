import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { config } from "../../config/index.js";
import type { AuthContext } from "../../types/auth.js";
import { normalizePermissions, normalizeStoreRoles } from "./claims.js";

const jwks = createRemoteJWKSet(new URL(config.auth.clerk.jwksUrl));

export async function verifyClerkTokenWithKeySet(
  token: string,
  keySet: JWTVerifyGetKey,
  trust: { audience?: string; authorizedParties: readonly string[]; issuer: string } = {
    audience: config.auth.clerk.jwtAudience,
    authorizedParties: config.auth.clerk.authorizedParties,
    issuer: config.auth.clerk.jwtIssuer
  },
): Promise<AuthContext> {
  const { payload } = await jwtVerify(token, keySet, {
    audience: trust.audience,
    issuer: trust.issuer
  });

  if (trust.authorizedParties.length > 0 &&
      (typeof payload.azp !== "string" || !trust.authorizedParties.includes(payload.azp))) {
    throw new Error("Verified Clerk token has an unauthorized party claim.");
  }

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

export async function verifyClerkToken(token: string): Promise<AuthContext> {
  return verifyClerkTokenWithKeySet(token, jwks);
}
