import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyClerkTokenWithKeySet } from "./jwt.js";

const issuer = "https://clerk.kapchi.example";
const audience = "https://api.kapchi.example";
const party = "https://shop.kapchi.example";
let keySet: ReturnType<typeof createLocalJWKSet>;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey as CryptoKey;
  const publicJwk = await exportJWK(pair.publicKey);
  keySet = createLocalJWKSet({ keys: [{ ...publicJwk, alg: "RS256", kid: "test-key", use: "sig" }] });
});

async function token(claims: Record<string, unknown> = {}, tokenIssuer = issuer) {
  return new SignJWT({ azp: party, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(tokenIssuer)
    .setAudience((claims.aud as string | string[] | undefined) ?? audience)
    .setSubject("user_123")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

const trust = { audience, authorizedParties: [party], issuer };

describe("Clerk JWT trust boundaries", () => {
  it("accepts the exact audience in single and multi-audience claims", async () => {
    await expect(verifyClerkTokenWithKeySet(await token(), keySet, trust)).resolves.toMatchObject({ userId: "user_123" });
    await expect(verifyClerkTokenWithKeySet(await token({ aud: ["another-resource", audience] }), keySet, trust)).resolves.toMatchObject({ userId: "user_123" });
  });

  it("rejects missing or wrong audience and issuer drift", async () => {
    await expect(verifyClerkTokenWithKeySet(await token({ aud: "wrong-resource" }), keySet, trust)).rejects.toThrow();
    await expect(verifyClerkTokenWithKeySet(await token({}, "https://other-clerk.example"), keySet, trust)).rejects.toThrow();
  });

  it("independently requires the authorized-party claim", async () => {
    await expect(verifyClerkTokenWithKeySet(await token({ azp: "https://evil.example" }), keySet, trust)).rejects.toThrow(/unauthorized party/);
    await expect(verifyClerkTokenWithKeySet(await token({ azp: null }), keySet, trust)).rejects.toThrow(/unauthorized party/);
  });
});
