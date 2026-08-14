import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config/index.js";
import { safeErrorDetails } from "../../observability/safe-error.js";

export const GUEST_SESSION_COOKIE = "session_id";
export const GUEST_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
export const MAX_GUEST_SESSION_RECORD_BYTES = 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_GUEST_CART_ITEMS = 100;
export const MAX_CART_SUBTOTAL_CENTS = 2_147_483_647;
type CookieNodeEnv = typeof config.app.nodeEnv;

type GuestSession = {
  cartId: string;
  createdAt: string;
};

export type GuestCartValidationStatus =
  | "valid"
  | "invalid"
  | "needs_reprice"
  | "unavailable";

export type GuestCartCustomizationSummary = {
  fontOptionId: string | null;
  line1: string;
  line2: string;
  imageAssetId: string | null;
  trimOptionId: string | null;
};

export type GuestCartDisplayItem = {
  cartItemId: string;
  listingId: string;
  listingSlug: string;
  title: string;
  quantity: number;
  unitAmountCents: number;
  currency: string;
  fabricId: string | null;
  customizationSetId: string;
  listingPriceVariantId: string;
  customizationSummary: GuestCartCustomizationSummary;
  validationStatus: GuestCartValidationStatus;
};

export type GuestCartContext = {
  cartId: string;
  sessionId: string;
};

export function hashSessionId(sessionId: string) {
  return createHash("sha256").update(sessionId).digest("hex");
}

export function buildGuestSessionKey(sessionId: string) {
  return `guest_session:${hashSessionId(sessionId)}`;
}

export function buildGuestCartItemsKey(cartId: string) {
  return `guest_cart:${cartId}:items`;
}

function generateSessionId() {
  return randomBytes(32).toString("base64url");
}

function isValidSessionId(sessionId: string | undefined): sessionId is string {
  return Boolean(sessionId && SESSION_ID_PATTERN.test(sessionId));
}

function parseGuestSession(value: string | null): GuestSession | null {
  if (
    !value ||
    Buffer.byteLength(value, "utf8") > MAX_GUEST_SESSION_RECORD_BYTES
  ) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);

    if (
      !isRecord(parsed) ||
      !hasExactKeys(parsed, ["cartId", "createdAt"]) ||
      !isUuid(parsed.cartId) ||
      !isIsoTimestamp(parsed.createdAt)
    ) {
      return null;
    }

    return {
      cartId: parsed.cartId,
      createdAt: parsed.createdAt
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
) {
  const keys = Object.keys(value);

  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

export function buildGuestSessionCookieOptions(
  nodeEnv: CookieNodeEnv = config.app.nodeEnv,
) {
  return {
    httpOnly: true,
    maxAge: GUEST_SESSION_TTL_SECONDS,
    path: "/",
    sameSite: "lax",
    secure: nodeEnv === "production"
  } as const;
}

function setGuestSessionCookie(reply: FastifyReply, sessionId: string) {
  reply.setCookie(
    GUEST_SESSION_COOKIE,
    sessionId,
    buildGuestSessionCookieOptions(),
  );
}

async function createGuestCartContext(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<GuestCartContext> {
  const sessionId = generateSessionId();
  const guestTokenHash = hashSessionId(sessionId);
  const createdAt = new Date();
  const expiresAt = new Date(
    createdAt.getTime() + GUEST_SESSION_TTL_SECONDS * 1000,
  );
  const session: GuestSession = {
    cartId: randomUUID(),
    createdAt: createdAt.toISOString()
  };

  await request.server.pg.query(
    `
      insert into carts (id, guest_token_hash, status, currency, expires_at)
      values ($1, $2, 'active', 'usd', $3)
    `,
    [session.cartId, guestTokenHash, expiresAt.toISOString()],
  );

  try {
    await request.server.redis.setEx(
      buildGuestSessionKey(sessionId),
      GUEST_SESSION_TTL_SECONDS,
      JSON.stringify(session),
    );
  } catch (error) {
    request.log.warn(
      {
        event: "cart.guest_session.cache_failed",
        cacheOperation: "create",
        cartId: session.cartId,
        cacheError: safeErrorDetails(error)
      },
      "Guest cart session cache write failed",
    );
  }

  setGuestSessionCookie(reply, sessionId);

  return {
    cartId: session.cartId,
    sessionId
  };
}

async function hasActiveDurableGuestCart(
  request: FastifyRequest,
  sessionId: string,
  cartId: string,
) {
  const result = await request.server.pg.query<{ id: string }>(
    `
      select id
      from carts
      where id = $1
        and guest_token_hash = $2
        and status = 'active'
        and expires_at > now()
      limit 1
    `,
    [cartId, hashSessionId(sessionId)],
  );

  return result.rows[0]?.id === cartId;
}

type DurableGuestCartRow = {
  created_at: Date | string;
  expires_at: Date | string;
  id: string;
};

function timestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function findDurableGuestCart(
  request: FastifyRequest,
  sessionId: string,
) {
  const result = await request.server.pg.query<DurableGuestCartRow>(
    `
      select id, created_at, expires_at
      from carts
      where guest_token_hash = $1
        and status = 'active'
        and expires_at > now()
      order by created_at desc, id desc
      limit 1
    `,
    [hashSessionId(sessionId)],
  );

  return result.rows[0] ?? null;
}

async function repairGuestSessionCache(
  request: FastifyRequest,
  sessionId: string,
  cart: DurableGuestCartRow,
) {
  const ttlSeconds = Math.floor(
    (new Date(cart.expires_at).getTime() - Date.now()) / 1000,
  );

  if (ttlSeconds < 1) {
    return false;
  }

  try {
    await request.server.redis.setEx(
      buildGuestSessionKey(sessionId),
      ttlSeconds,
      JSON.stringify({ cartId: cart.id, createdAt: timestamp(cart.created_at) }),
    );
    return true;
  } catch (error) {
    request.log.warn(
      {
        event: "cart.guest_session.cache_failed",
        cacheOperation: "repair",
        cartId: cart.id,
        cacheError: safeErrorDetails(error)
      },
      "Guest cart session cache repair failed",
    );
    return false;
  }
}

async function resolveGuestCartContext(
  request: FastifyRequest,
  sessionId: string,
): Promise<GuestCartContext | null> {
  let cacheOutcome: "error" | "invalid" | "miss" | "stale" = "miss";
  let cachedSession: GuestSession | null = null;

  try {
    const cachedValue = await request.server.redis.get(buildGuestSessionKey(sessionId));
    cachedSession = parseGuestSession(cachedValue);
    cacheOutcome = cachedSession
      ? "stale"
      : cachedValue === null
        ? "miss"
        : "invalid";
  } catch (error) {
    cacheOutcome = "error";
    request.log.warn(
      {
        event: "cart.guest_session.cache_failed",
        cacheOperation: "read",
        cacheError: safeErrorDetails(error)
      },
      "Guest cart session cache read failed",
    );
  }

  if (
    cachedSession &&
    (await hasActiveDurableGuestCart(request, sessionId, cachedSession.cartId))
  ) {
    return { cartId: cachedSession.cartId, sessionId };
  }

  const durableCart = await findDurableGuestCart(request, sessionId);
  if (!durableCart) {
    return null;
  }

  const cacheRepaired = await repairGuestSessionCache(
    request,
    sessionId,
    durableCart,
  );
  request.log.info(
    {
      event: "cart.guest_session.recovered",
      cacheOutcome,
      cacheRepaired,
      cartId: durableCart.id
    },
    "Guest cart session recovered from durable state",
  );

  return { cartId: durableCart.id, sessionId };
}

export async function getOrCreateGuestCartContext(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<GuestCartContext> {
  const sessionId = request.cookies[GUEST_SESSION_COOKIE];

  if (isValidSessionId(sessionId)) {
    const context = await resolveGuestCartContext(request, sessionId);
    if (context) {
      return context;
    }
  }

  return createGuestCartContext(request, reply);
}

export async function getGuestCartContext(
  request: FastifyRequest,
): Promise<GuestCartContext | null> {
  const sessionId = request.cookies[GUEST_SESSION_COOKIE];

  if (!isValidSessionId(sessionId)) {
    return null;
  }

  return resolveGuestCartContext(request, sessionId);
}

export async function getGuestCartSessionContext(
  request: FastifyRequest,
): Promise<GuestCartContext | null> {
  const sessionId = request.cookies[GUEST_SESSION_COOKIE];

  if (!isValidSessionId(sessionId)) {
    return null;
  }

  const result = await request.server.pg.query<{ id: string }>(
    `
      select id
      from carts
      where guest_token_hash = $1
        and (
          (status = 'active' and expires_at > now())
          or status = 'checkout_started'
        )
      order by created_at desc, id desc
      limit 1
    `,
    [hashSessionId(sessionId)],
  );
  const cartId = result.rows[0]?.id;

  if (!cartId) {
    return null;
  }

  return {
    cartId,
    sessionId
  };
}

export async function getGuestCartClaimContext(
  request: FastifyRequest,
): Promise<GuestCartContext | null> {
  const sessionId = request.cookies[GUEST_SESSION_COOKIE];

  if (!isValidSessionId(sessionId)) {
    return null;
  }

  const result = await request.server.pg.query<{ id: string }>(
    `
      select id
      from carts
      where guest_token_hash = $1
        and status = 'active'
        and expires_at > now()
      order by created_at desc, id desc
      limit 1
    `,
    [hashSessionId(sessionId)],
  );
  const cartId = result.rows[0]?.id;

  return cartId ? { cartId, sessionId } : null;
}
