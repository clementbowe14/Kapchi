import { buildApiUrl } from "@/lib/api";
import type {
  AdminOrderDetail,
  AdminOrderFilters,
  AdminOrderTimelinePage,
  AdminFulfillmentView,
  AdminOrderItem,
  AdminOrderSearchPage,
  AdminShipmentView,
  AdminOrderSummary,
  ConfirmShipmentResponse,
  CustomerSnapshot,
  FulfillmentStatus,
  LifecycleCommand,
  LifecycleMutationResponse,
  Money,
  NoteResponse,
  PaymentSummary,
  ProductionFieldAvailability,
  ShipmentStatus,
  TimelineActorType,
  TimelineLifecycleState,
  TimelineView,
} from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const knownErrorCodes = new Set([
  "ADMIN_ORDERS_UNAVAILABLE",
  "FORBIDDEN",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_CURSOR",
  "MESSAGE_ACTOR_UNAVAILABLE",
  "MESSAGE_IDEMPOTENCY_CONFLICT",
  "ORDER_ACTOR_UNAVAILABLE",
  "ORDER_NOT_FOUND",
  "ORDER_REVISION_CONFLICT",
  "ORDER_TRANSITION_NOT_ALLOWED",
  "SHIPMENT_ALREADY_CONFIRMED",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
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

function boolean(value: unknown, field: string) {
  if (typeof value !== "boolean") throw malformed(field);
  return value;
}

function literal<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw malformed(field);
  return value as T;
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

const fulfillmentStatusValues = [
  "not_started", "queued", "in_progress", "ready_to_ship", "shipped", "delivered", "cancelled",
] as const satisfies readonly FulfillmentStatus[];
const shipmentStatusValues = [
  "label_pending", "label_purchased", "in_transit", "delivered", "completed", "voided", "failed",
] as const satisfies readonly ShipmentStatus[];
const confirmedShipmentStatuses = new Set<ShipmentStatus>(["in_transit", "delivered", "completed"]);
const trackingHosts = new Set([
  "tools.usps.com",
  "www.ups.com",
  "www.fedex.com",
  "www.dhl.com",
]);

function safeTrackingUrl(value: unknown, status: ShipmentStatus, field: string) {
  if (value === null) return null;
  const text = requiredString(value, field);
  if (!confirmedShipmentStatuses.has(status)) return null;
  try {
    const parsed = new URL(text);
    if (
      parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash ||
      !trackingHosts.has(parsed.hostname)
    ) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseFulfillment(value: unknown, field: string): AdminFulfillmentView {
  const source = record(value, field);
  return {
    fulfillmentNumber: integer(source.fulfillmentNumber, `${field}.fulfillmentNumber`),
    id: requiredString(source.id, `${field}.id`),
    shippingAddressSnapshot: source.shippingAddressSnapshot === null
      ? null
      : record(source.shippingAddressSnapshot, `${field}.shippingAddressSnapshot`),
    status: literal(source.status, fulfillmentStatusValues, `${field}.status`),
  };
}

export function parseAdminShipment(value: unknown, field = "shipment"): AdminShipmentView {
  const source = record(value, field);
  const status = literal(source.status, shipmentStatusValues, `${field}.status`);
  return {
    carrier: nullableString(source.carrier, `${field}.carrier`),
    carrierService: nullableString(source.carrierService, `${field}.carrierService`),
    id: requiredString(source.id, `${field}.id`),
    shippedAt: nullableString(source.shippedAt, `${field}.shippedAt`),
    shipmentNumber: integer(source.shipmentNumber, `${field}.shipmentNumber`),
    status,
    trackingNumber: nullableString(source.trackingNumber, `${field}.trackingNumber`),
    trackingUrl: safeTrackingUrl(source.trackingUrl, status, `${field}.trackingUrl`),
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
  if (!Array.isArray(source.fulfillments)) throw malformed("response.fulfillments");
  if (!Array.isArray(source.shipments)) throw malformed("response.shipments");
  return {
    ...summary,
    cancelledAt: nullableString(source.cancelledAt, "response.cancelledAt"),
    completedAt: nullableString(source.completedAt, "response.completedAt"),
    contactSnapshot: parseCustomer(source.contactSnapshot, "response.contactSnapshot"),
    fulfillments: source.fulfillments.map((entry, index) =>
      parseFulfillment(entry, `response.fulfillments[${index}]`)),
    items: source.items.map((item, index) => parseItem(item, `response.items[${index}]`)),
    paidAt: nullableString(source.paidAt, "response.paidAt"),
    shipments: source.shipments
      .map((entry, index) => parseAdminShipment(entry, `response.shipments[${index}]`))
      .sort((left, right) => right.shipmentNumber - left.shipmentNumber || right.id.localeCompare(left.id)),
    shippedAt: nullableString(source.shippedAt, "response.shippedAt"),
    shipping: {
      address: shipping.address === null ? null : record(shipping.address, "response.shipping.address"),
      name: nullableString(shipping.name, "response.shipping.name"),
    },
  };
}

const actorTypes = ["admin", "customer", "system"] as const;
const eventTypes = [
  "order.production_started", "order.ready_to_ship", "order.shipment_confirmed", "order.updated",
] as const;
const orderTimelineStates = [
  "pending_payment", "paid", "in_production", "ready_to_ship", "shipped", "completed", "cancelled", "refunded",
] as const;
const fulfillmentTimelineStates = [
  "not_started", "queued", "in_progress", "ready_to_ship", "shipped", "delivered", "cancelled",
] as const;

function actorName(value: unknown, actorType: TimelineActorType, field: string) {
  if (value !== null && typeof value !== "string") throw malformed(field);
  const provided = typeof value === "string" ? value.trim() : "";
  if (provided) return provided;
  if (actorType === "admin") return "Store admin";
  if (actorType === "customer") return "Customer";
  return "System";
}

function timelineBase(source: Record<string, unknown>, field: string) {
  const actorType = literal(source.actorType, actorTypes, `${field}.actorType`);
  return {
    actorName: actorName(source.actorName, actorType, `${field}.actorName`),
    actorType,
    id: requiredString(source.id, `${field}.id`),
    occurredAt: requiredString(source.occurredAt, `${field}.occurredAt`),
  };
}

function parseLifecycleState(value: unknown, field: string): TimelineLifecycleState | null {
  if (value === null) return null;
  const source = record(value, field);
  return {
    fulfillmentStatus: literal(source.fulfillmentStatus, fulfillmentTimelineStates, `${field}.fulfillmentStatus`),
    orderStatus: literal(source.orderStatus, orderTimelineStates, `${field}.orderStatus`),
  };
}

export function parseTimelineEntry(value: unknown, field = "entry"): TimelineView {
  const source = record(value, field);
  const kind = literal(source.kind, ["event", "internal_note", "message", "refund"] as const, `${field}.kind`);
  const base = timelineBase(source, field);
  if (kind === "event") {
    if (source.visibility !== "internal") throw malformed(`${field}.visibility`);
    return {
      ...base,
      eventType: literal(source.eventType, eventTypes, `${field}.eventType`),
      from: parseLifecycleState(source.from, `${field}.from`),
      kind,
      to: parseLifecycleState(source.to, `${field}.to`),
      visibility: "internal",
    };
  }
  if (kind === "internal_note") {
    if (source.visibility !== "internal" || (base.actorType !== "admin" && base.actorType !== "system")) {
      throw malformed(`${field}.visibility`);
    }
    return {
      ...base,
      actorType: base.actorType,
      body: requiredString(source.body, `${field}.body`),
      kind,
      status: literal(source.status, ["sent"] as const, `${field}.status`),
      visibility: "internal",
    };
  }
  if (kind === "message") {
    if (source.visibility !== "customer_visible") throw malformed(`${field}.visibility`);
    return {
      ...base,
      body: requiredString(source.body, `${field}.body`),
      channel: literal(source.channel, ["email", "sms"] as const, `${field}.channel`),
      direction: literal(source.direction, ["inbound", "outbound"] as const, `${field}.direction`),
      kind,
      status: literal(source.status, ["draft", "queued", "sent", "failed"] as const, `${field}.status`),
      subject: nullableString(source.subject, `${field}.subject`),
      visibility: "customer_visible",
    };
  }
  if (source.visibility !== "internal" || (base.actorType !== "admin" && base.actorType !== "system")) {
    throw malformed(`${field}.visibility`);
  }
  const currency = requiredString(source.currency, `${field}.currency`).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw malformed(`${field}.currency`);
  return {
    ...base,
    actorType: base.actorType,
    amountMinor: integer(source.amountMinor, `${field}.amountMinor`),
    currency,
    kind: "refund",
    status: literal(source.status, ["pending", "succeeded", "failed"] as const, `${field}.status`),
    visibility: "internal",
  };
}

export function parseAdminOrderTimelinePage(value: unknown): AdminOrderTimelinePage {
  const source = record(value, "response");
  if (!Array.isArray(source.entries)) throw malformed("response.entries");
  return {
    entries: source.entries.map((entry, index) => parseTimelineEntry(entry, `response.entries[${index}]`)),
    nextCursor: nullableString(source.nextCursor, "response.nextCursor"),
  };
}

function retryAfter(response: Response) {
  const value = Number(response.headers.get("retry-after"));
  return Number.isSafeInteger(value) && value > 0 && value <= 3600 ? value : null;
}

function errorMessage(status: number) {
  if (status === 401) return "Your admin session needs to be refreshed.";
  if (status === 403) return "Your account does not have permission to perform this admin action.";
  if (status === 404) return "That order could not be found.";
  if (status === 409) return "The order changed before this action could be completed.";
  if (status === 503) return "Admin order data is temporarily unavailable.";
  if (status === 400) return "The request contains invalid information.";
  return "The admin order request could not be completed.";
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

function assertOrderId(orderId: string) {
  if (!UUID_PATTERN.test(orderId)) {
    throw new AdminOrdersApiError("That order identifier is invalid.", 400, "INVALID_ORDER_ID");
  }
}

async function adminFetch(
  token: string,
  path: string,
  signal: AbortSignal,
  init: Omit<RequestInit, "headers" | "signal"> = {},
  headers: Record<string, string> = {},
) {
  try {
    return await fetch(buildApiUrl(path), {
      ...init,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AdminOrdersApiError("The admin order service could not be reached.", 0, "NETWORK_ERROR");
  }
}

export async function fetchAdminOrderTimeline(
  token: string,
  orderId: string,
  signal: AbortSignal,
  cursor?: string,
) {
  assertOrderId(orderId);
  const query = new URLSearchParams({ limit: "25", sort: "occurred_desc" });
  if (cursor) query.set("cursor", cursor);
  const response = await adminFetch(
    token,
    `/admin/orders/${encodeURIComponent(orderId)}/timeline?${query}`,
    signal,
  );
  if (!response.ok) throw await responseError(response);
  return parseAdminOrderTimelinePage(await response.json());
}

function parseLifecycleMutationResponse(value: unknown): LifecycleMutationResponse {
  const source = record(value, "response");
  const command = literal(
    source.command,
    ["start_production", "mark_ready_to_ship"] as const,
    "response.command",
  );
  const expected = command === "start_production"
    ? { fulfillmentStatus: "in_progress" as const, orderStatus: "in_production" as const }
    : { fulfillmentStatus: "ready_to_ship" as const, orderStatus: "ready_to_ship" as const };
  if (source.fulfillmentStatus !== expected.fulfillmentStatus || source.orderStatus !== expected.orderStatus) {
    throw malformed("response.transition");
  }
  return {
    command,
    fulfillmentStatus: expected.fulfillmentStatus,
    orderId: requiredString(source.orderId, "response.orderId"),
    orderStatus: expected.orderStatus,
    paymentStatus: literal(source.paymentStatus, ["paid", "partially_refunded"] as const, "response.paymentStatus"),
    replayed: boolean(source.replayed, "response.replayed"),
    revision: integer(source.revision, "response.revision"),
    transitionedAt: requiredString(source.transitionedAt, "response.transitionedAt"),
  };
}

function parseConfirmedShipment(value: unknown): ConfirmShipmentResponse {
  const source = record(value, "response");
  const shipment = record(source.shipment, "response.shipment");
  const trackingUrl = safeTrackingUrl(shipment.trackingUrl, "in_transit", "response.shipment.trackingUrl");
  if (source.command !== "confirm_shipment" || source.fulfillmentStatus !== "shipped" || source.orderStatus !== "shipped") {
    throw malformed("response.transition");
  }
  return {
    command: "confirm_shipment",
    fulfillmentStatus: "shipped",
    orderId: requiredString(source.orderId, "response.orderId"),
    orderStatus: "shipped",
    paymentStatus: literal(source.paymentStatus, ["paid", "partially_refunded"] as const, "response.paymentStatus"),
    replayed: boolean(source.replayed, "response.replayed"),
    revision: integer(source.revision, "response.revision"),
    shipment: {
      carrier: nullableString(shipment.carrier, "response.shipment.carrier"),
      carrierService: nullableString(shipment.carrierService, "response.shipment.carrierService"),
      id: requiredString(shipment.id, "response.shipment.id"),
      shippedAt: nullableString(shipment.shippedAt, "response.shipment.shippedAt"),
      trackingNumber: nullableString(shipment.trackingNumber, "response.shipment.trackingNumber"),
      trackingUrl,
    },
    transitionedAt: requiredString(source.transitionedAt, "response.transitionedAt"),
  };
}

async function postAdminMutation<T>(
  token: string,
  path: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  parser: (value: unknown) => T,
) {
  const response = await adminFetch(token, path, signal, {
    body: JSON.stringify(body),
    method: "POST",
  }, {
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
  });
  if (!response.ok) throw await responseError(response);
  return parser(await response.json());
}

export async function runLifecycleCommand(
  token: string,
  orderId: string,
  command: LifecycleCommand,
  input: { expectedRevision: number; reason?: string },
  idempotencyKey: string,
  signal: AbortSignal,
) {
  assertOrderId(orderId);
  const path = command === "start_production" ? "start-production" : "mark-ready-to-ship";
  return postAdminMutation(
    token,
    `/admin/orders/${encodeURIComponent(orderId)}/actions/${path}`,
    idempotencyKey,
    input,
    signal,
    parseLifecycleMutationResponse,
  );
}

export async function confirmAdminShipment(
  token: string,
  orderId: string,
  input: {
    carrier: string;
    carrierService?: string;
    expectedRevision: number;
    reason?: string;
    shipmentId?: string;
    trackingNumber: string;
  },
  idempotencyKey: string,
  signal: AbortSignal,
) {
  assertOrderId(orderId);
  return postAdminMutation(
    token,
    `/admin/orders/${encodeURIComponent(orderId)}/actions/confirm-shipment`,
    idempotencyKey,
    input,
    signal,
    parseConfirmedShipment,
  );
}

function parseNoteResponse(value: unknown): NoteResponse {
  const source = record(value, "response");
  if (
    source.channel !== "internal_note" || source.direction !== "internal" || source.failedAt !== null ||
    source.senderType !== "admin" || source.status !== "sent" || source.subject !== null
  ) throw malformed("response.note");
  return {
    body: requiredString(source.body, "response.body"),
    channel: "internal_note",
    createdAt: requiredString(source.createdAt, "response.createdAt"),
    direction: "internal",
    failedAt: null,
    id: requiredString(source.id, "response.id"),
    senderType: "admin",
    sentAt: requiredString(source.sentAt, "response.sentAt"),
    status: "sent",
    subject: null,
  };
}

export async function addInternalOrderNote(
  token: string,
  orderId: string,
  body: string,
  idempotencyKey: string,
  signal: AbortSignal,
) {
  assertOrderId(orderId);
  const response = await adminFetch(
    token,
    `/admin/messages/orders/${encodeURIComponent(orderId)}/notes`,
    signal,
    { body: JSON.stringify({ body }), method: "POST" },
    { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
  );
  if (!response.ok) throw await responseError(response);
  if (response.status !== 200 && response.status !== 201) throw malformed("response.status");
  return { note: parseNoteResponse(await response.json()), replayed: response.status === 200 };
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
