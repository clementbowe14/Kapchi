import { ShippingExportError } from "./errors.js";
import type { PackageInput, ShippingAddress } from "./types.js";

const controls = /[\u0000-\u001f\u007f-\u009f]/g;
const whitespace = /\s+/g;
const formulaPrefix = /^[=+\-@]/;

export function normalizeText(value: unknown) {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(controls, " ").replace(whitespace, " ").trim()
    : "";
}

export function safeRoutingText(
  value: unknown,
  field: string,
  maximum: number,
  required = true,
) {
  const normalized = normalizeText(value);
  if ((required && !normalized) || normalized.length > maximum || formulaPrefix.test(normalized)) {
    throw new ShippingExportError(
      "EXPORT_ADDRESS_INCOMPLETE",
      "A shipping address or contact field is invalid.",
      409,
      { field },
    );
  }
  return normalized;
}

export function normalizeUsAddress(value: unknown): ShippingAddress {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ShippingExportError(
      "EXPORT_ADDRESS_INCOMPLETE",
      "A complete U.S. shipping address is required.",
      409,
    );
  }
  const address = value as Record<string, unknown>;
  const country = normalizeText(address.country).toUpperCase();
  if (country !== "US") {
    throw new ShippingExportError(
      "EXPORT_INTERNATIONAL_UNSUPPORTED",
      "Only U.S. shipping addresses are supported by this export.",
      409,
    );
  }
  const state = safeRoutingText(address.state, "state", 2).toUpperCase();
  const postalCode = safeRoutingText(address.postalCode, "postalCode", 10);
  if (!/^[A-Z]{2}$/.test(state) || !/^\d{5}(?:-\d{4})?$/.test(postalCode)) {
    throw new ShippingExportError(
      "EXPORT_ADDRESS_INCOMPLETE",
      "A valid U.S. state and ZIP code are required.",
      409,
    );
  }
  const line2 = safeRoutingText(address.line2, "line2", 128, false);
  return {
    city: safeRoutingText(address.city, "city", 100),
    country: "US",
    line1: safeRoutingText(address.line1, "line1", 128),
    ...(line2 ? { line2 } : {}),
    postalCode,
    state
  };
}

export function normalizePhone(value: unknown) {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  let digits = normalized.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length < 7 || digits.length > 15) {
    throw new ShippingExportError(
      "EXPORT_CONTACT_INVALID",
      "The customer phone number is invalid.",
      409,
      { field: "phone" },
    );
  }
  return digits;
}

function decimal(value: number, field: string, maximum: number) {
  if (!Number.isFinite(value) || value < 0.01 || value > maximum) {
    throw new ShippingExportError(
      "EXPORT_PACKAGE_INVALID",
      "Package measurements are outside the supported range.",
      400,
      { field },
    );
  }
  const rounded = Math.round(value * 100) / 100;
  if (Math.abs(value - rounded) > Number.EPSILON) {
    throw new ShippingExportError(
      "EXPORT_PACKAGE_INVALID",
      "Package measurements may have at most two decimal places.",
      400,
      { field },
    );
  }
  return rounded.toFixed(2).replace(/\.?0+$/, "");
}

export function normalizePackage(input: PackageInput) {
  const description = normalizeText(input.description);
  if (description.length > 120) {
    throw new ShippingExportError(
      "EXPORT_PACKAGE_INVALID",
      "Package description is too long.",
      400,
      { field: "description" },
    );
  }
  return {
    description: description || null,
    heightInches: decimal(input.heightInches, "heightInches", 120),
    lengthInches: decimal(input.lengthInches, "lengthInches", 120),
    weightOunces: decimal(input.weightOunces, "weightOunces", 2400),
    widthInches: decimal(input.widthInches, "widthInches", 120)
  };
}

export function safeItemTitle(value: unknown) {
  const normalized = normalizeText(value);
  return formulaPrefix.test(normalized) ? `'${normalized}` : normalized;
}
