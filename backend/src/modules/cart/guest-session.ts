import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RedisClientType } from "redis";
import { config } from "../../config/index.js";

export const GUEST_SESSION_COOKIE = "session_id";
export const GUEST_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
type CookieNodeEnv = typeof config.app.nodeEnv;

type GuestSession = {
  cartId: string;
  createdAt: string;
};

export type GuestCartItem = Record<string, unknown>;

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
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<GuestSession>;

    if (typeof parsed.cartId !== "string" || typeof parsed.createdAt !== "string") {
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
  redis: RedisClientType,
  reply: FastifyReply,
): Promise<GuestCartContext> {
  const sessionId = generateSessionId();
  const session: GuestSession = {
    cartId: randomUUID(),
    createdAt: new Date().toISOString()
  };

  await redis.setEx(
    buildGuestSessionKey(sessionId),
    GUEST_SESSION_TTL_SECONDS,
    JSON.stringify(session),
  );

  setGuestSessionCookie(reply, sessionId);

  return {
    cartId: session.cartId,
    sessionId
  };
}

export async function getOrCreateGuestCartContext(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<GuestCartContext> {
  const sessionId = request.cookies[GUEST_SESSION_COOKIE];

  if (isValidSessionId(sessionId)) {
    const session = parseGuestSession(
      await request.server.redis.get(buildGuestSessionKey(sessionId)),
    );

    if (session) {
      return {
        cartId: session.cartId,
        sessionId
      };
    }
  }

  return createGuestCartContext(request.server.redis, reply);
}

export async function getGuestCartItems(redis: RedisClientType, cartId: string) {
  const value = await redis.get(buildGuestCartItemsKey(cartId));

  if (!value) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed as GuestCartItem[];
}
