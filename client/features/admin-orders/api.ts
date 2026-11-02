import { buildApiUrl } from "@/lib/api";
import type {
  AdminOrderDetail,
  AdminOrderFilters,
  AdminOrderItem,
  AdminOrderSearchPage,
  AdminOrderSummary,
  CustomerSnapshot,
  Money,
  PaymentSummary,
  ProductionFieldAvailability,
} from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const knownErrorCodes = new Set([
  "ADMIN_ORDERS_UNAVAILABLE",
  "ORDER_NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
]);

export class AdminOrdersApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "AdminOrdersApiError";
  }
}

export function adminOrdersErrorMessage(error: AdminOrdersApiError) {
  return `${error.message}${error.retryAfterSeconds
    ? ` Try again in about ${error.retryAfterSeconds} seconds.`
    : ""}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function malformed(field: string): AdminOrdersApiError {
  return new AdminOrdersApiError(
    `The admin order response was invalid (${field}).`,
    0,
    "INVALID_RESPONSE",
  );
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string") throw malformed(field);
  return value;
}

function nullableString(value: unknown, field: string) {
  if (value === null) return null;
  return requiredString(value, field);
}

function integer(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw malformed(field);
  return Number(value);
}

function record(value: unknown, field: string) {
  if (!isRecord(value)) throw malformed(field);
  return value;
}

function parseMoney(value: unknown, field: string): Money {
  const source = record(value, field);
  return {
    amountMinor: integer(source.amountMinor, `${field}.amountMinor`),
    currency: requiredString(source.currency, `${field}.currency`),
  };
}

function parseCustomer(value: unknown, field: string): CustomerSnapshot {
  const source = record(value, field);
  const method = source.preferredContactMethod;
  if (method !== null && method !== "email" && method !== "sms" && method !== "phone") {
    throw malformed(`${field}.preferredContactMethod`);
  }
  return {
    email: nullableString(source.email, `${field}.email`),
    name: nullableString(source.name, `${field}.name`),
    phone: nullableString(source.phone, `${field}.phone`),
    preferredContactMethod: method,
  };
}

function parsePayment(value: unknown, field: string): PaymentSummary {
  const source = record(value, field);
  const integrity = source.currencyIntegrity;
  if (integrity !== "consistent" && integrity !== "mismatch" && integrity !== "unavailable") {
    throw malformed(`${field}.currencyIntegrity`);
  }
  return {
    captured: source.captured === null ? null : parseMoney(source.captured, `${field}.captured`),
    currencyIntegrity: integrity,
    pendingRefunds: parseMoney(source.pendingRefunds, `${field}.pendingRefunds`),
    refundableBalance: source.refundableBalance === null
      ? null
      : parseMoney(source.refundableBalance, `${field}.refundableBalance`),
    succeededRefunds: parseMoney(source.succeededRefunds, `${field}.succeededRefunds`),
  };
}

function parseSummary(value: unknown, field: string): AdminOrderSummary {
  const source = record(value, field);
  return {
    createdAt: requiredString(source.createdAt, `${field}.createdAt`),
    customer: parseCustomer(source.customer, `${field}.customer`),
    discount: parseMoney(source.discount, `${field}.discount`),
    fulfillmentStatus: requiredString(source.fulfillmentStatus, `${field}.fulfillmentStatus`),
    id: requiredString(source.id, `${field}.id`),
    itemCount: integer(source.itemCount, `${field}.itemCount`),
    payment: parsePayment(source.payment, `${field}.payment`),
    paymentStatus: requiredString(source.paymentStatus, `${field}.paymentStatus`),
    publicOrderNumber: requiredString(source.publicOrderNumber, `${field}.publicOrderNumber`),
    revision: integer(source.revision, `${field}.revision`),
    status: requiredString(source.status, `${field}.status`),
    total: parseMoney(source.total, `${field}.total`),
    totalQuantity: integer(source.totalQuantity, `${field}.totalQuantity`),
    updatedAt: requiredString(source.updatedAt, `${field}.updatedAt`),
  };
}

function parseAvailability(value: unknown, field: string): ProductionFieldAvailability {
  if (value !== "present" && value !== "not_selected" && value !== "not_stored") {
    throw malformed(field);
  }
  return value;
}

function parseItem(value: unknown, field: string): AdminOrderItem {
  const source = record(value, field);
  const catalog = record(source.catalogReference, `${field}.catalogReference`);
  const asset = record(source.customizationAsset, `${field}.customizationAsset`);
  const production = record(source.production, `${field}.production`);
  const availability = record(production.availability, `${field}.production.availability`);
  const text = record(production.text, `${field}.production.text`);
  const snapshots = record(source.snapshots, `${field}.snapshots`);
  const reason = asset.unavailableReason;
  if (reason !== null && reason !== "ASSET_RECORD_MISSING" && reason !== "ASSET_NOT_SELECTED") {
    throw malformed(`${field}.customizationAsset.unavailableReason`);
  }
  return {
    catalogReference: {
      fabricStatus: nullableString(catalog.fabricStatus, `${field}.catalogReference.fabricStatus`),
      listingStatus: nullableString(catalog.listingStatus, `${field}.catalogReference.listingStatus`),
    },
    currency: requiredString(source.currency, `${field}.currency`),
    customizationAsset: {
      recordStatus: nullableString(asset.recordStatus, `${field}.customizationAsset.recordStatus`),
      unavailableReason: reason,
    },
    id: requiredString(source.id, `${field}.id`),
    production: {
      availability: {
        font: parseAvailability(availability.font, `${field}.production.availability.font`),
        placement: parseAvailability(availability.placement, `${field}.production.availability.placement`),
        text: parseAvailability(availability.text, `${field}.production.availability.text`),
        trim: parseAvailability(availability.trim, `${field}.production.availability.trim`),
      },
      estimateSnapshot: production.estimateSnapshot === null
        ? null
        : record(production.estimateSnapshot, `${field}.production.estimateSnapshot`),
      font: production.font,
      placement: production.placement,
      priorityCode: nullableString(production.priorityCode, `${field}.production.priorityCode`),
      text: {
        line1: nullableString(text.line1, `${field}.production.text.line1`),
        line2: nullableString(text.line2, `${field}.production.text.line2`),
      },
      trim: production.trim,
    },
    productionNotes: nullableString(source.productionNotes, `${field}.productionNotes`),
    quantity: integer(source.quantity, `${field}.quantity`),
    snapshots: {
      customization: record(snapshots.customization, `${field}.snapshots.customization`),
      fabric: snapshots.fabric === null ? null : record(snapshots.fabric, `${field}.snapshots.fabric`),
      listing: record(snapshots.listing, `${field}.snapshots.listing`),
    },
    total: parseMoney(source.total, `${field}.total`),
    unitPrice: parseMoney(source.unitPrice, `${field}.unitPrice`),
  };
}

export function parseAdminOrderSearchPage(value: unknown): AdminOrderSearchPage {
  const source = record(value, "response");
  if (!Array.isArray(source.orders)) throw malformed("response.orders");
  return {
    nextCursor: nullableString(source.nextCursor, "response.nextCursor"),
    orders: source.orders.map((order, index) => parseSummary(order, `response.orders[${index}]`)),
  };
}

export function parseAdminOrderDetail(value: unknown): AdminOrderDetail {
  const source = record(value, "response");
  const summary = parseSummary(source, "response");
  const shipping = record(source.shipping, "response.shipping");
  if (!Array.isArray(source.items)) throw malformed("response.items");
  return {
    ...summary,
    cancelledAt: nullableString(source.cancelledAt, "response.cancelledAt"),
    completedAt: nullableString(source.completedAt, "response.completedAt"),
    contactSnapshot: parseCustomer(source.contactSnapshot, "response.contactSnapshot"),
    items: source.items.map((item, index) => parseItem(item, `response.items[${index}]`)),
    paidAt: nullableString(source.paidAt, "response.paidAt"),
    shippedAt: nullableString(source.shippedAt, "response.shippedAt"),
    shipping: {
      address: shipping.address === null ? null : record(shipping.address, "response.shipping.address"),
      name: nullableString(shipping.name, "response.shipping.name"),
    },
  };
}

function retryAfter(response: Response) {
  const value = Number(response.headers.get("retry-after"));
  return Number.isSafeInteger(value) && value > 0 && value <= 3600 ? value : null;
}

function errorMessage(status: number) {
  if (status === 401) return "Your admin session needs to be refreshed.";
  if (status === 403) return "Your account does not have permission to view admin orders.";
  if (status === 404) return "That order could not be found.";
  if (status === 503) return "Admin order data is temporarily unavailable.";
  return "Admin orders could not be loaded.";
}

async function responseError(response: Response) {
  let code: string | null = null;
  try {
    const body = await response.json();
    if (isRecord(body) && typeof body.error === "string" && knownErrorCodes.has(body.error)) {
      code = body.error;
    }
  } catch {
    // Client-owned status copy is sufficient for non-JSON responses.
  }
  return new AdminOrdersApiError(errorMessage(response.status), response.status, code, retryAfter(response));
}

export function serializeAdminOrderFilters(filters: AdminOrderFilters, cursor?: string) {
  const query = new URLSearchParams({ lifecycle: "ongoing", limit: "25", sort: filters.sort });
  if (filters.orderStatus) query.set("orderStatus", filters.orderStatus);
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}

export async function fetchAdminOrders(
  token: string,
  filters: AdminOrderFilters,
  signal: AbortSignal,
  cursor?: string,
) {
  let response: Response;
  try {
    response = await fetch(buildApiUrl(`/admin/orders?${serializeAdminOrderFilters(filters, cursor)}`), {
      cache: "no-store",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AdminOrdersApiError("Admin orders could not be reached.", 0, "NETWORK_ERROR");
  }
  if (!response.ok) throw await responseError(response);
  return parseAdminOrderSearchPage(await response.json());
}

export async function fetchAdminOrder(token: string, orderId: string, signal: AbortSignal) {
  if (!UUID_PATTERN.test(orderId)) {
    throw new AdminOrdersApiError("That order identifier is invalid.", 400, "INVALID_ORDER_ID");
  }
  let response: Response;
  try {
    response = await fetch(buildApiUrl(`/admin/orders/${encodeURIComponent(orderId)}`), {
      cache: "no-store",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AdminOrdersApiError("The admin order could not be reached.", 0, "NETWORK_ERROR");
  }
  if (!response.ok) throw await responseError(response);
  return parseAdminOrderDetail(await response.json());
}

export type AdminTokenGetter = (options?: { skipCache?: boolean }) => Promise<string | null>;

export async function withAdminToken<T>(
  getToken: AdminTokenGetter,
  request: (token: string) => Promise<T>,
) {
  let token: string | null;
  try {
    token = await getToken();
  } catch {
    throw new AdminOrdersApiError("Your admin session is unavailable.", 401, "TOKEN_UNAVAILABLE");
  }
  if (!token) throw new AdminOrdersApiError("Sign in to view admin orders.", 401, "MISSING_TOKEN");
  try {
    return await request(token);
  } catch (error) {
    if (!(error instanceof AdminOrdersApiError) || error.status !== 401) throw error;
    let refreshedToken: string | null;
    try {
      refreshedToken = await getToken({ skipCache: true });
    } catch {
      throw new AdminOrdersApiError("Your admin session is unavailable.", 401, "TOKEN_UNAVAILABLE");
    }
    if (!refreshedToken) throw error;
    return request(refreshedToken);
  }
}
