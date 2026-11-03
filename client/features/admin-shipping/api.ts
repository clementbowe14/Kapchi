import { buildApiUrl } from "@/lib/api";
import { AdminOrdersApiError } from "@/features/admin-orders/api";
import type {
  CorrectShippingAddressInput,
  CreateShippingExportInput,
  PackageMeasurements,
  ShippingExportBatch,
  ShippingExportBatchItem,
  ShippingExportBatchPage,
  ShippingExportCandidate,
  ShippingExportPreflight,
} from "./types";

const knownShippingCodes = new Set([
  "EXPORT_ADDRESS_INCOMPLETE",
  "EXPORT_ALREADY_PREPARED",
  "EXPORT_BATCH_EXPIRED",
  "EXPORT_BATCH_INACTIVE",
  "EXPORT_BATCH_INELIGIBLE",
  "EXPORT_BATCH_NOT_FOUND",
  "EXPORT_CONTACT_INVALID",
  "EXPORT_FILE_TOO_LARGE",
  "EXPORT_INTERNATIONAL_UNSUPPORTED",
  "EXPORT_PACKAGE_INVALID",
  "EXPORT_REVISION_STALE",
  "EXPORT_SHIPMENT_CONFLICT",
  "FORBIDDEN",
  "IDEMPOTENCY_CONFLICT",
  "ORDER_ACTOR_UNAVAILABLE",
  "ORDER_NOT_FOUND",
  "ORDER_REVISION_CONFLICT",
  "SHIPPING_EXPORT_UNAVAILABLE",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(field: string): never {
  throw new AdminOrdersApiError(`The shipping export response was invalid (${field}).`, 0, "INVALID_RESPONSE");
}

function record(value: unknown, field: string) {
  if (!isRecord(value)) invalid(field);
  return value;
}

function text(value: unknown, field: string) {
  if (typeof value !== "string") invalid(field);
  return value;
}

function nullableText(value: unknown, field: string) {
  return value === null || value === undefined ? null : text(value, field);
}

function integer(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(field);
  return Number(value);
}

function stringList(value: unknown, field: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) invalid(field);
  return value as string[];
}

function parsePackage(value: unknown, field: string): PackageMeasurements | null {
  if (value === null || value === undefined) return null;
  const source = record(value, field);
  const asInput = (entry: unknown, name: string) => entry === null || entry === undefined
    ? ""
    : typeof entry === "number" || typeof entry === "string" ? String(entry) : invalid(name);
  return {
    description: nullableText(source.description, `${field}.description`) ?? "",
    heightInches: asInput(source.heightInches, `${field}.heightInches`),
    lengthInches: asInput(source.lengthInches, `${field}.lengthInches`),
    weightOunces: asInput(source.weightOunces, `${field}.weightOunces`),
    widthInches: asInput(source.widthInches, `${field}.widthInches`),
  };
}

function parseCandidate(value: unknown, field: string): ShippingExportCandidate {
  const source = record(value, field);
  if (typeof source.eligible !== "boolean") invalid(`${field}.eligible`);
  return {
    codes: stringList(source.codes ?? [], `${field}.codes`),
    eligible: source.eligible,
    existingPackage: parsePackage(source.existingPackage ?? source.package ?? null, `${field}.existingPackage`),
    orderId: text(source.orderId, `${field}.orderId`),
    publicOrderNumber: text(source.publicOrderNumber, `${field}.publicOrderNumber`),
    revision: integer(source.revision, `${field}.revision`),
  };
}

export function parseShippingExportPreflight(value: unknown): ShippingExportPreflight {
  const source = record(value, "response");
  const rows = source.candidates ?? source.orders;
  if (!Array.isArray(rows)) invalid("response.candidates");
  return { candidates: rows.map((row, index) => parseCandidate(row, `response.candidates[${index}]`)) };
}

function parseBatchItem(value: unknown, field: string): ShippingExportBatchItem {
  const source = record(value, field);
  return {
    orderId: text(source.orderId, `${field}.orderId`),
    publicOrderNumber: text(source.publicOrderNumber, `${field}.publicOrderNumber`),
    shipmentId: text(source.shipmentId, `${field}.shipmentId`),
  };
}

export function parseShippingExportBatch(value: unknown): ShippingExportBatch {
  const source = record(value, "response");
  const status = text(source.status ?? "prepared", "response.status");
  if (status !== "prepared" && status !== "cancelled" && status !== "expired") invalid("response.status");
  const actionValues = source.allowedActions ?? (status === "prepared"
    ? ["download", "cancel", "confirm_shipment"]
    : status === "expired" ? ["release", "confirm_shipment"] : []);
  const allowedActions = stringList(actionValues, "response.allowedActions");
  if (allowedActions.some((action) => !["cancel", "confirm_shipment", "download", "release"].includes(action))) {
    invalid("response.allowedActions");
  }
  const items = source.items ?? source.orders ?? [];
  if (!Array.isArray(items)) invalid("response.items");
  const batchId = text(source.batchId ?? source.id, "response.batchId");
  return {
    allowedActions: allowedActions as ShippingExportBatch["allowedActions"],
    batchId,
    createdAt: nullableText(source.createdAt, "response.createdAt"),
    downloadPath: nullableText(source.downloadPath, "response.downloadPath"),
    expiresAt: text(source.expiresAt, "response.expiresAt"),
    filename: text(source.filename, "response.filename"),
    items: items.map((item, index) => parseBatchItem(item, `response.items[${index}]`)),
    mappingVersion: integer(source.mappingVersion, "response.mappingVersion"),
    rowCount: integer(source.rowCount, "response.rowCount"),
    status,
  };
}

export function parseShippingExportBatchPage(value: unknown): ShippingExportBatchPage {
  const source = record(value, "response");
  if (!Array.isArray(source.batches)) invalid("response.batches");
  return {
    batches: source.batches.map(parseShippingExportBatch),
    nextCursor: nullableText(source.nextCursor, "response.nextCursor"),
  };
}

function shippingErrorMessage(status: number) {
  if (status === 401) return "Your admin session needs to be refreshed.";
  if (status === 403) return "Your account cannot manage shipping exports.";
  if (status === 404) return "That shipping export could not be found.";
  if (status === 409) return "The shipping export changed before this action completed.";
  if (status === 410) return "That shipping export is no longer available.";
  if (status === 503) return "Shipping exports are temporarily unavailable.";
  if (status === 400) return "Review the shipping information and try again.";
  return "The shipping export request could not be completed.";
}

async function responseError(response: Response) {
  let code: string | null = null;
  try {
    const body = await response.json();
    if (isRecord(body) && typeof body.error === "string" && knownShippingCodes.has(body.error)) code = body.error;
  } catch {
    // Status-based copy deliberately avoids rendering server exception text.
  }
  return new AdminOrdersApiError(shippingErrorMessage(response.status), response.status, code);
}

async function shippingFetch(token: string, path: string, signal: AbortSignal, init: RequestInit = {}) {
  try {
    return await fetch(buildApiUrl(path), {
      ...init,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AdminOrdersApiError("The shipping export service could not be reached.", 0, "NETWORK_ERROR");
  }
}

export async function preflightShippingExport(token: string, orderIds: string[], signal: AbortSignal) {
  const response = await shippingFetch(token, "/admin/shipping/export-candidates", signal, {
    body: JSON.stringify({ orderIds }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) throw await responseError(response);
  return parseShippingExportPreflight(await response.json());
}

export async function createShippingExport(
  token: string,
  input: CreateShippingExportInput,
  idempotencyKey: string,
  signal: AbortSignal,
) {
  const response = await shippingFetch(token, "/admin/shipping/export-batches", signal, {
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    method: "POST",
  });
  if (!response.ok) throw await responseError(response);
  return parseShippingExportBatch(await response.json());
}

export async function listShippingExports(token: string, signal: AbortSignal, cursor?: string) {
  const query = new URLSearchParams({ status: "prepared,expired" });
  if (cursor) query.set("cursor", cursor);
  const response = await shippingFetch(token, `/admin/shipping/export-batches?${query}`, signal);
  if (!response.ok) throw await responseError(response);
  return parseShippingExportBatchPage(await response.json());
}

export async function getShippingExport(token: string, batchId: string, signal: AbortSignal) {
  const response = await shippingFetch(token, `/admin/shipping/export-batches/${encodeURIComponent(batchId)}`, signal);
  if (!response.ok) throw await responseError(response);
  return parseShippingExportBatch(await response.json());
}

export async function downloadShippingExport(token: string, batch: ShippingExportBatch, signal: AbortSignal) {
  const path = batch.downloadPath ?? `/admin/shipping/export-batches/${encodeURIComponent(batch.batchId)}/file`;
  const response = await shippingFetch(token, path, signal, { headers: { Accept: "text/csv" } });
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

async function postBatchCommand(
  token: string,
  batchId: string,
  command: "cancel" | "release",
  reason: string,
  idempotencyKey: string,
  signal: AbortSignal,
) {
  const response = await shippingFetch(
    token,
    `/admin/shipping/export-batches/${encodeURIComponent(batchId)}/${command}`,
    signal,
    {
      body: JSON.stringify({
        expectedStatus: command === "cancel" ? "prepared" : "expired",
        intent: "no_label_purchased",
        reason,
      }),
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      method: "POST",
    },
  );
  if (!response.ok) throw await responseError(response);
  const body = record(await response.json(), "response");
  return {
    batchId: text(body.batchId ?? body.id ?? batchId, "response.batchId"),
    status: command === "cancel" ? "cancelled" as const : "expired" as const,
  };
}

export function cancelShippingExport(token: string, batchId: string, reason: string, key: string, signal: AbortSignal) {
  return postBatchCommand(token, batchId, "cancel", reason, key, signal);
}

export function releaseShippingExport(token: string, batchId: string, reason: string, key: string, signal: AbortSignal) {
  return postBatchCommand(token, batchId, "release", reason, key, signal);
}

export async function correctShippingAddress(
  token: string,
  orderId: string,
  input: CorrectShippingAddressInput,
  idempotencyKey: string,
  signal: AbortSignal,
) {
  const response = await shippingFetch(
    token,
    `/admin/orders/${encodeURIComponent(orderId)}/actions/correct-shipping-address`,
    signal,
    {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      method: "POST",
    },
  );
  if (!response.ok) throw await responseError(response);
  return response.json();
}

export function triggerCsvDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url));
}
