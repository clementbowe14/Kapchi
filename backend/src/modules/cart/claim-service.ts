import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import type { RedisClientType } from "redis";
import type { AuthContext } from "../../types/auth.js";
import {
  buildGuestCartItemsKey,
  buildGuestSessionKey,
  type GuestCartContext
} from "./guest-session.js";
import { CartClaimRepository } from "./claim-repository.js";
import type { VerifiedCartIdentity } from "./claim-types.js";

type SafeLogger = Pick<FastifyBaseLogger, "warn">;

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function claimString(claims: AuthContext["claims"], keys: string[]) {
  for (const key of keys) {
    const value = claims[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function identityFromAuth(auth: AuthContext): VerifiedCartIdentity {
  const claimedEmail = claimString(auth.claims, ["email", "email_address"]);
  const firstName = claimString(auth.claims, ["first_name"]);
  const lastName = claimString(auth.claims, ["last_name"]);
  const combinedName = [firstName, lastName].filter(Boolean).join(" ") || null;

  return {
    authSubject: auth.userId,
    avatarUrl: claimString(auth.claims, ["image_url", "picture"]),
    displayName: claimString(auth.claims, ["name"]) ?? combinedName,
    email:
      claimedEmail && EMAIL_PATTERN.test(claimedEmail)
        ? claimedEmail.toLowerCase()
        : null,
    phone: claimString(auth.claims, ["phone_number", "phone"])
  };
}

function safeCleanupError(error: unknown) {
  return error instanceof Error ? { name: error.name } : { name: "UnknownError" };
}

export class CartClaimService {
  private readonly repository: CartClaimRepository;

  constructor(
    pool: Pick<Pool, "connect" | "query">,
    private readonly redis: RedisClientType,
    private readonly logger: SafeLogger,
    repository?: CartClaimRepository,
  ) {
    this.repository = repository ?? new CartClaimRepository(pool);
  }

  async claim(auth: AuthContext, guestContext: GuestCartContext | null) {
    const result = await this.repository.claim(
      identityFromAuth(auth),
      guestContext,
    );

    if (guestContext) {
      try {
        await this.redis.del([
          buildGuestSessionKey(guestContext.sessionId),
          buildGuestCartItemsKey(guestContext.cartId)
        ]);
      } catch (error) {
        this.logger.warn(
          {
            cartId: guestContext.cartId,
            cleanupError: safeCleanupError(error)
          },
          "Guest cart cleanup failed after durable claim",
        );
      }
    }

    return result;
  }
}
