import type { AdminOrderItem, Money, ProductionFieldAvailability } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function primitive(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return "";
}

const opaqueIdentifierPatterns = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  /^(?:price|prod|asset|font|trim|opt)_[A-Za-z0-9]+$/,
];

function safeProductionLabel(value: unknown) {
  const label = primitive(value);
  if (!label || label.length > 120 || opaqueIdentifierPatterns.some((pattern) => pattern.test(label))) {
    return "";
  }
  return label;
}

export function formatAdminMoney(money: Money) {
  if (!Number.isSafeInteger(money.amountMinor) || !/^[A-Za-z]{3}$/.test(money.currency)) {
    return "Not available";
  }
  try {
    const formatter = new Intl.NumberFormat("en-US", {
      currency: money.currency.toUpperCase(),
      style: "currency",
    });
    const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(money.amountMinor / (10 ** fractionDigits));
  } catch {
    return "Not available";
  }
}

export function formatAdminDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function statusLabel(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ") || "Unknown";
}

export function snapshotLabel(
  snapshot: Record<string, unknown> | null,
  keys: readonly string[],
) {
  if (!snapshot) return null;
  for (const key of keys) {
    const value = primitive(snapshot[key]);
    if (value) return value;
  }
  return null;
}

const selectionKeys = {
  font: ["name", "label", "family", "style"],
  placement: ["name", "label", "side", "position", "orientation"],
  trim: ["name", "label", "size", "width", "color", "unit"],
} as const;

export function formatProductionSelection(
  kind: keyof typeof selectionKeys,
  value: unknown,
  availability: ProductionFieldAvailability,
) {
  if (availability === "not_selected") return "Not selected";
  if (availability === "not_stored") return "Not stored";
  const direct = safeProductionLabel(value);
  if (direct) return direct;
  if (Array.isArray(value)) return "Stored selection";
  if (isRecord(value)) {
    const values = selectionKeys[kind]
      .map((key) => safeProductionLabel(value[key]))
      .filter(Boolean);
    return values.length ? values.join(" / ") : "Stored selection";
  }
  return "Stored selection";
}

export function formatProductionEstimate(snapshot: Record<string, unknown> | null) {
  if (!snapshot) return "Not stored";
  const label = primitive(snapshot.priorityLabel);
  const minimum = primitive(snapshot.minimumBusinessDays);
  const maximum = primitive(snapshot.maximumBusinessDays);
  if (minimum && maximum) {
    return `${label ? `${label}: ` : ""}${minimum}-${maximum} business days`;
  }
  return label || "Stored estimate";
}

export function customizationLevel(snapshot: Record<string, unknown>) {
  return snapshotLabel(snapshot, [
    "levelName",
    "level",
    "customizationType",
    "type",
  ]) ?? "Not stored";
}

export function customizationImageStatus(item: AdminOrderItem) {
  if (item.customizationAsset.unavailableReason === "ASSET_NOT_SELECTED") {
    return "Not selected";
  }
  if (item.customizationAsset.unavailableReason === "ASSET_RECORD_MISSING") {
    return "Unavailable";
  }
  return item.customizationAsset.recordStatus ? "Selected" : "Not selected";
}

export function formatAddress(address: Record<string, unknown> | null) {
  if (!address) return [];
  const line1 = primitive(address.line1);
  const line2 = primitive(address.line2);
  const city = primitive(address.city);
  const state = primitive(address.state);
  const postalCode = primitive(address.postalCode) || primitive(address.postal_code);
  const country = primitive(address.country);
  const locality = [city, state, postalCode].filter(Boolean).join(", ");
  return [line1, line2, locality, country].filter(Boolean);
}
