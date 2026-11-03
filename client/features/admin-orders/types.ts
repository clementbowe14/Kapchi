export const ongoingOrderStatuses = [
  "pending_payment",
  "paid",
  "in_production",
  "ready_to_ship",
  "shipped",
  "refunded",
] as const;

export type OngoingOrderStatus = (typeof ongoingOrderStatuses)[number];
export type OrderSort = "created_asc" | "created_desc";
export type Money = { amountMinor: number; currency: string };

export type CustomerSnapshot = {
  email: string | null;
  name: string | null;
  phone: string | null;
  preferredContactMethod: "email" | "sms" | "phone" | null;
};

export type PaymentSummary = {
  captured: Money | null;
  currencyIntegrity: "consistent" | "mismatch" | "unavailable";
  pendingRefunds: Money;
  refundableBalance: Money | null;
  succeededRefunds: Money;
};

export type AdminOrderSummary = {
  createdAt: string;
  customer: CustomerSnapshot;
  discount: Money;
  fulfillmentStatus: string;
  id: string;
  itemCount: number;
  payment: PaymentSummary;
  paymentStatus: string;
  publicOrderNumber: string;
  revision: number;
  status: string;
  total: Money;
  totalQuantity: number;
  updatedAt: string;
};

export type AdminOrderSearchPage = {
  nextCursor: string | null;
  orders: AdminOrderSummary[];
};

export type ProductionFieldAvailability = "present" | "not_selected" | "not_stored";

export type AdminOrderItem = {
  catalogReference: { fabricStatus: string | null; listingStatus: string | null };
  currency: string;
  customizationAsset: {
    recordStatus: string | null;
    unavailableReason: "ASSET_RECORD_MISSING" | "ASSET_NOT_SELECTED" | null;
  };
  id: string;
  production: {
    availability: {
      font: ProductionFieldAvailability;
      placement: ProductionFieldAvailability;
      text: ProductionFieldAvailability;
      trim: ProductionFieldAvailability;
    };
    estimateSnapshot: Record<string, unknown> | null;
    font: unknown;
    placement: unknown;
    priorityCode: string | null;
    text: { line1: string | null; line2: string | null };
    trim: unknown;
  };
  productionNotes: string | null;
  quantity: number;
  snapshots: {
    customization: Record<string, unknown>;
    fabric: Record<string, unknown> | null;
    listing: Record<string, unknown>;
  };
  total: Money;
  unitPrice: Money;
};

export const fulfillmentStatuses = [
  "not_started",
  "queued",
  "in_progress",
  "ready_to_ship",
  "shipped",
  "delivered",
  "cancelled",
] as const;

export type FulfillmentStatus = (typeof fulfillmentStatuses)[number];

export type AdminFulfillmentView = {
  fulfillmentNumber: number;
  id: string;
  shippingAddressSnapshot: Record<string, unknown> | null;
  status: FulfillmentStatus;
};

export const shipmentStatuses = [
  "label_pending",
  "label_purchased",
  "in_transit",
  "delivered",
  "completed",
  "voided",
  "failed",
] as const;

export type ShipmentStatus = (typeof shipmentStatuses)[number];

export type AdminShipmentView = {
  carrier: string | null;
  carrierService: string | null;
  id: string;
  shippedAt: string | null;
  shipmentNumber: number;
  status: ShipmentStatus;
  trackingNumber: string | null;
  trackingUrl: string | null;
};

export type AdminOrderDetail = AdminOrderSummary & {
  cancelledAt: string | null;
  completedAt: string | null;
  contactSnapshot: CustomerSnapshot;
  fulfillments: AdminFulfillmentView[];
  items: AdminOrderItem[];
  paidAt: string | null;
  shipments: AdminShipmentView[];
  shippedAt: string | null;
  shipping: { address: Record<string, unknown> | null; name: string | null };
};

export type TimelineActorType = "admin" | "customer" | "system";
export type TimelineVisibility = "internal" | "customer_visible";
export type TimelineEventType =
  | "order.production_started"
  | "order.ready_to_ship"
  | "order.shipment_confirmed"
  | "order.updated";
export type TimelineState =
  | "pending_payment" | "paid" | "in_production" | "ready_to_ship"
  | "shipped" | "completed" | "cancelled" | "refunded"
  | "unpaid" | "checkout_started" | "failed" | "partially_refunded"
  | "not_started" | "queued" | "in_progress" | "delivered";

export type TimelineLifecycleState = {
  fulfillmentStatus: Extract<TimelineState,
    "not_started" | "queued" | "in_progress" | "ready_to_ship" |
    "shipped" | "delivered" | "cancelled">;
  orderStatus: Extract<TimelineState,
    "pending_payment" | "paid" | "in_production" | "ready_to_ship" |
    "shipped" | "completed" | "cancelled" | "refunded">;
};

export type TimelineView =
  | { kind: "event"; id: string; occurredAt: string; visibility: "internal"; actorType: TimelineActorType; actorName: string; eventType: TimelineEventType; from: TimelineLifecycleState | null; to: TimelineLifecycleState | null }
  | { kind: "internal_note"; id: string; occurredAt: string; visibility: "internal"; actorType: "admin" | "system"; actorName: string; body: string; status: "sent" }
  | { kind: "message"; id: string; occurredAt: string; visibility: "customer_visible"; actorType: TimelineActorType; actorName: string; channel: "email" | "sms"; direction: "inbound" | "outbound"; status: "draft" | "queued" | "sent" | "failed"; subject: string | null; body: string }
  | { kind: "refund"; id: string; occurredAt: string; visibility: "internal"; actorType: "admin" | "system"; actorName: string; amountMinor: number; currency: string; status: "pending" | "succeeded" | "failed" };

export type AdminOrderTimelinePage = {
  entries: TimelineView[];
  nextCursor: string | null;
};

export type LifecycleCommand = "start_production" | "mark_ready_to_ship";

export type LifecycleMutationResponse = {
  command: LifecycleCommand;
  fulfillmentStatus: "in_progress" | "ready_to_ship";
  orderId: string;
  orderStatus: "in_production" | "ready_to_ship";
  paymentStatus: "paid" | "partially_refunded";
  replayed: boolean;
  revision: number;
  transitionedAt: string;
};

export type ConfirmShipmentResponse = {
  command: "confirm_shipment";
  fulfillmentStatus: "shipped";
  orderId: string;
  orderStatus: "shipped";
  paymentStatus: "paid" | "partially_refunded";
  replayed: boolean;
  revision: number;
  shipment: Omit<AdminShipmentView, "shipmentNumber" | "status">;
  transitionedAt: string;
};

export type NoteResponse = {
  body: string;
  channel: "internal_note";
  createdAt: string;
  direction: "internal";
  failedAt: null;
  id: string;
  senderType: "admin";
  sentAt: string;
  status: "sent";
  subject: null;
};

export type AdminOrderFilters = {
  orderStatus?: OngoingOrderStatus;
  sort: OrderSort;
};

export function isOngoingOrderStatus(value: unknown): value is OngoingOrderStatus {
  return ongoingOrderStatuses.includes(value as OngoingOrderStatus);
}

export function isOrderSort(value: unknown): value is OrderSort {
  return value === "created_asc" || value === "created_desc";
}
