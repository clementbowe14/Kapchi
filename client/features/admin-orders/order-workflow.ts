import type { AdminOrderDetail } from "./types";

export type OrderAction = "start_production" | "mark_ready_to_ship" | "confirm_shipment";

export type ActionDecision = {
  action: OrderAction | null;
  explanation: string;
};

const paidStatuses = new Set(["paid", "partially_refunded"]);
const activeShipmentStatuses = new Set(["in_transit", "delivered", "completed"]);
const terminalStatuses = new Set(["cancelled", "completed", "refunded"]);

export function decideOrderAction(order: AdminOrderDetail): ActionDecision {
  const primary = order.fulfillments.find((entry) => entry.fulfillmentNumber === 1);
  if (terminalStatuses.has(order.status)) {
    return { action: null, explanation: "No fulfillment action is available for this order." };
  }
  if (!paidStatuses.has(order.paymentStatus) || !order.paidAt) {
    return { action: null, explanation: "Payment must be confirmed before fulfillment can continue." };
  }
  if (order.status === "paid") {
    if (!order.shipping.address) {
      return { action: null, explanation: "A shipping address is required before production can begin." };
    }
    if (!primary || primary.status === "queued") return { action: "start_production", explanation: "" };
    return { action: null, explanation: "The fulfillment workflow state must be refreshed before continuing." };
  }
  if (order.status === "in_production") {
    if (!primary?.shippingAddressSnapshot) {
      return { action: null, explanation: "A shipping address is required before fulfillment can continue." };
    }
    if (primary.status === "in_progress") return { action: "mark_ready_to_ship", explanation: "" };
    return { action: null, explanation: "The fulfillment workflow state must be refreshed before continuing." };
  }
  if (order.status === "ready_to_ship") {
    if (!primary?.shippingAddressSnapshot) {
      return { action: null, explanation: "A shipping address is required before shipment can be confirmed." };
    }
    if (order.shipments.some((shipment) => activeShipmentStatuses.has(shipment.status))) {
      return { action: null, explanation: "Shipment is already recorded for this order." };
    }
    if (primary.status === "ready_to_ship") return { action: "confirm_shipment", explanation: "" };
    return { action: null, explanation: "The fulfillment workflow state must be refreshed before continuing." };
  }
  return { action: null, explanation: "No fulfillment action is available for the current order state." };
}

const controls = /[\u0000-\u001f\u007f]/;

export function validateReason(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length < 3) return "Enter at least 3 characters or leave the reason blank.";
  if (trimmed.length > 500) return "Keep the reason to 500 characters or fewer.";
  return null;
}

export function validateNote(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "Enter an internal note.";
  if (trimmed.length > 10_000) return "Keep the note to 10,000 characters or fewer.";
  return null;
}

function validateShipmentText(value: string, label: string, maximum: number, required: boolean) {
  const trimmed = value.trim();
  if (required && !trimmed) return `${label} is required.`;
  if (trimmed.length > maximum) return `${label} must be ${maximum} characters or fewer.`;
  if (controls.test(trimmed)) return `${label} cannot contain control characters.`;
  return null;
}

export function validateShipment(values: {
  carrier: string;
  carrierService: string;
  reason: string;
  trackingNumber: string;
}) {
  return {
    carrier: validateShipmentText(values.carrier, "Carrier", 100, true),
    carrierService: validateShipmentText(values.carrierService, "Carrier service", 100, false),
    reason: validateReason(values.reason),
    trackingNumber: validateShipmentText(values.trackingNumber, "Tracking number", 200, true),
  };
}
