import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RedisClientType } from "redis";
import { config } from "../../config/index.js";

export const GUEST_SESSION_COOKIE = "session_id";
export const GUEST_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
export const MAX_GUEST_SESSION_RECORD_BYTES = 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[a-z]{3}$/;
const MAX_GUEST_CART_PROJECTION_BYTES = 64 * 1024;
const MAX_GUEST_CART_ITEMS = 100;
const MAX_GUEST_CART_QUANTITY = 999;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const MAX_LISTING_TEXT_LENGTH = 255;
const MAX_CUSTOMIZATION_LINE_LENGTH = 512;
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
  line1: string;
  line2: string;
  imageAssetId: string | null;
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

function isBoundedString(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const characterLength = Array.from(value).length;
  return characterLength >= minimumLength && characterLength <= maximumLength;
}

function isIntegerBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function parseGuestCartCustomizationSummary(
  value: unknown,
): GuestCartCustomizationSummary | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["line1", "line2", "imageAssetId"]) ||
    !isBoundedString(value.line1, 0, MAX_CUSTOMIZATION_LINE_LENGTH) ||
    !isBoundedString(value.line2, 0, MAX_CUSTOMIZATION_LINE_LENGTH) ||
    !(value.imageAssetId === null || isUuid(value.imageAssetId))
  ) {
    return null;
  }

  return {
    line1: value.line1,
    line2: value.line2,
    imageAssetId: value.imageAssetId
  };
}

function parseGuestCartDisplayItem(value: unknown): GuestCartDisplayItem | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "cartItemId",
      "listingId",
      "listingSlug",
      "title",
      "quantity",
      "unitAmountCents",
      "currency",
      "fabricId",
      "customizationSetId",
      "customizationSummary",
      "validationStatus"
    ]) ||
    !isUuid(value.cartItemId) ||
    !isUuid(value.listingId) ||
    !isBoundedString(value.listingSlug, 1, MAX_LISTING_TEXT_LENGTH) ||
    !isBoundedString(value.title, 1, MAX_LISTING_TEXT_LENGTH) ||
    !isIntegerBetween(value.quantity, 1, MAX_GUEST_CART_QUANTITY) ||
    !isIntegerBetween(value.unitAmountCents, 0, MAX_POSTGRES_INTEGER) ||
    typeof value.currency !== "string" ||
    !CURRENCY_PATTERN.test(value.currency) ||
    !(value.fabricId === null || isUuid(value.fabricId)) ||
    !isUuid(value.customizationSetId) ||
    !(
      value.validationStatus === "valid" ||
      value.validationStatus === "invalid" ||
      value.validationStatus === "needs_reprice" ||
      value.validationStatus === "unavailable"
    )
  ) {
    return null;
  }

  const customizationSummary = parseGuestCartCustomizationSummary(
    value.customizationSummary,
  );

  if (!customizationSummary) {
    return null;
  }

  return {
    cartItemId: value.cartItemId,
    listingId: value.listingId,
    listingSlug: value.listingSlug,
    title: value.title,
    quantity: value.quantity,
    unitAmountCents: value.unitAmountCents,
    currency: value.currency,
    fabricId: value.fabricId,
    customizationSetId: value.customizationSetId,
    customizationSummary,
    validationStatus: value.validationStatus
  };
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
    try {
      await request.server.pg.query(
        `
          update carts
          set status = 'abandoned'
          where id = $1
            and guest_token_hash = $2
            and status = 'active'
        `,
        [session.cartId, guestTokenHash],
      );
    } catch (abandonmentError) {
      request.log.error(
        { cartId: session.cartId, err: abandonmentError },
        "Failed to abandon guest cart after Redis session write failure",
      );
    }

    throw error;
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

export async function getOrCreateGuestCartContext(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<GuestCartContext> {
  const sessionId = request.cookies[GUEST_SESSION_COOKIE];

  if (isValidSessionId(sessionId)) {
    const session = parseGuestSession(
      await request.server.redis.get(buildGuestSessionKey(sessionId)),
    );

    if (
      session &&
      (await hasActiveDurableGuestCart(request, sessionId, session.cartId))
    ) {
      return {
        cartId: session.cartId,
        sessionId
      };
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

  const session = parseGuestSession(
    await request.server.redis.get(buildGuestSessionKey(sessionId)),
  );

  if (
    !session ||
    !(await hasActiveDurableGuestCart(request, sessionId, session.cartId))
  ) {
    return null;
  }

  return {
    cartId: session.cartId,
    sessionId
  };
}

export async function getGuestCartItems(
  redis: RedisClientType,
  cartId: string,
): Promise<GuestCartDisplayItem[]> {
  const value = await redis.get(buildGuestCartItemsKey(cartId));

  if (!value) {
    return [];
  }

  if (Buffer.byteLength(value, "utf8") > MAX_GUEST_CART_PROJECTION_BYTES) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed) || parsed.length > MAX_GUEST_CART_ITEMS) {
    return [];
  }

  const items: GuestCartDisplayItem[] = [];

  for (const item of parsed) {
    const displayItem = parseGuestCartDisplayItem(item);

    if (!displayItem) {
      return [];
    }

    items.push(displayItem);
  }

  return items;
}
