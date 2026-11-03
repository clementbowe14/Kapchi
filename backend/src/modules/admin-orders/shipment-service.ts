import { AdminOrderError } from "./errors.js";
import { confirmedTrackingIdentity, deriveTrackingUrl, normalizeCarrier, trackingIdentity } from "./tracking.js";
import type { ConfirmShipmentInput } from "./types.js";

export type PreparedShipment = ConfirmShipmentInput & {
  carrier: string;
  carrierService?: string;
  trackingIdentity: string;
  trackingUrl: string | null;
};

export function prepareShipment(input: ConfirmShipmentInput): PreparedShipment {
  const carrier = normalizeCarrier(input.carrier);
  const trackingNumber = input.trackingNumber.trim();
  if (trackingIdentity(trackingNumber).length === 0) {
    throw new AdminOrderError("VALIDATION_ERROR", "A valid tracking number is required.", 400);
  }
  return {
    ...input,
    carrier,
    carrierService: input.carrierService?.trim() || undefined,
    reason: input.reason?.trim() || undefined,
    trackingIdentity: confirmedTrackingIdentity(carrier, trackingNumber),
    trackingNumber,
    trackingUrl: deriveTrackingUrl(carrier, trackingNumber)
  };
}

export function isConfirmedShipmentStatus(status: string) {
  return status === "in_transit" || status === "delivered" || status === "completed";
}

export function isReusableShipmentStatus(status: string) {
  return status === "label_pending" || status === "label_purchased" || status === "failed";
}
