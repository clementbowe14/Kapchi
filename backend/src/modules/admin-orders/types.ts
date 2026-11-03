export type OrderStatus =
  | "pending_payment"
  | "paid"
  | "in_production"
  | "ready_to_ship"
  | "shipped"
  | "completed"
  | "cancelled"
  | "refunded";

export type PaymentStatus =
  | "unpaid"
  | "checkout_started"
  | "paid"
  | "failed"
  | "refunded"
  | "partially_refunded";

export type FulfillmentStatus =
  | "not_started"
  | "queued"
  | "in_progress"
  | "ready_to_ship"
  | "shipped"
  | "delivered"
  | "cancelled";

export type AdminOrderSearchQuery = {
  createdFrom?: string;
  createdTo?: string;
  cursor?: string;
  discountedOnly: boolean;
  fabricId?: string;
  fulfillmentStatus?: FulfillmentStatus;
  lifecycle: "ongoing" | "completed" | "cancelled" | "all";
  limit: number;
  listingId?: string;
  orderStatus?: OrderStatus;
  paidOnly: boolean;
  paymentStatus?: PaymentStatus;
  refundedOnly: boolean;
  search?: string;
  sort: "created_asc" | "created_desc";
};

export type AdminOrderTimelineQuery = {
  cursor?: string;
  limit: number;
  sort?: "occurred_asc" | "occurred_desc";
};

export type AdminOrderMutationCommand =
  | "start_production"
  | "mark_ready_to_ship";

export type AdminOrderMutationInput = {
  expectedRevision: number;
  reason?: string;
};

export type AdminOrderMutationActor = {
  authSubject: string;
  userId: string;
};

export type AdminOrderMutationResult = {
  command: AdminOrderMutationCommand;
  fulfillmentStatus: FulfillmentStatus;
  orderId: string;
  orderStatus: OrderStatus;
  paymentStatus: PaymentStatus;
  replayed: boolean;
  revision: number;
  transitionedAt: string;
};

export type ConfirmShipmentInput = AdminOrderMutationInput & {
  carrier: string;
  carrierService?: string;
  shipmentId?: string;
  trackingNumber: string;
};

export type ConfirmShipmentResult = {
  command: "confirm_shipment";
  fulfillmentStatus: "shipped";
  orderId: string;
  orderStatus: "shipped";
  paymentStatus: "paid" | "partially_refunded";
  replayed: boolean;
  revision: number;
  shipment: {
    carrier: string;
    carrierService: string | null;
    id: string;
    shippedAt: string;
    trackingNumber: string;
    trackingUrl: string | null;
  };
  transitionedAt: string;
};

export type Money = {
  amountMinor: number;
  currency: string;
};

export type PaymentSummary = {
  captured: Money | null;
  currencyIntegrity: "consistent" | "mismatch" | "unavailable";
  pendingRefunds: Money;
  refundableBalance: Money | null;
  succeededRefunds: Money;
};

export type CustomerSnapshot = {
  email: string | null;
  name: string | null;
  phone: string | null;
  preferredContactMethod: "email" | "sms" | "phone" | null;
};

export type AdminOrderSummary = {
  createdAt: string;
  customer: CustomerSnapshot;
  discount: Money;
  fulfillmentStatus: FulfillmentStatus;
  id: string;
  itemCount: number;
  payment: PaymentSummary;
  paymentStatus: PaymentStatus;
  publicOrderNumber: string;
  revision: number;
  status: OrderStatus;
  total: Money;
  totalQuantity: number;
  updatedAt: string;
};

export type AdminOrderSearchPage = {
  nextCursor: string | null;
  orders: AdminOrderSummary[];
};

export type ProductionFieldAvailability =
  | "present"
  | "not_selected"
  | "not_stored";

export type AdminOrderItem = {
  catalogReference: {
    fabricStatus: string | null;
    listingStatus: string | null;
  };
  currency: string;
  customizationAsset: {
    id: string | null;
    recordStatus: string | null;
    unavailableReason: "ASSET_RECORD_MISSING" | "ASSET_NOT_SELECTED" | null;
  };
  id: string;
  listingId: string | null;
  listingPriceVariantId: string | null;
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
    variant: {
      currency: string;
      listingPriceVariantId: string | null;
      stripePriceId: string | null;
      stripeProductId: string | null;
      unitAmountMinor: number;
    };
  };
  total: Money;
  unitPrice: Money;
};

export type AdminOrderDetail = AdminOrderSummary & {
  cancelledAt: string | null;
  completedAt: string | null;
  contactSnapshot: CustomerSnapshot;
  fulfillments: Array<Record<string, unknown>>;
  items: AdminOrderItem[];
  paidAt: string | null;
  shipments: Array<Record<string, unknown>>;
  shippedAt: string | null;
  shipping: {
    address: Record<string, unknown> | null;
    issueCode: string | null;
    name: string | null;
    status: "valid" | "missing" | "invalid";
  };
};

export type TimelineActorType = "admin" | "customer" | "system";

export type TimelineLifecycleState = {
  fulfillmentStatus: FulfillmentStatus;
  orderStatus: OrderStatus;
};

type TimelineBase = {
  actorName: string;
  actorType: TimelineActorType;
  id: string;
  occurredAt: string;
  visibility: "customer_visible" | "internal";
};

export type AdminOrderTimelineEntry =
  | TimelineBase & {
      eventType: "order.production_started" | "order.ready_to_ship" | "order.shipment_confirmed" | "order.updated";
      from: TimelineLifecycleState | null;
      kind: "event";
      to: TimelineLifecycleState | null;
      visibility: "internal";
    }
  | TimelineBase & {
      body: string;
      kind: "internal_note";
      status: "sent";
      visibility: "internal";
    }
  | TimelineBase & {
      body: string;
      channel: "email" | "sms";
      direction: "inbound" | "outbound";
      kind: "message";
      status: "draft" | "queued" | "sent" | "failed";
      subject: string | null;
      visibility: "customer_visible";
    }
  | TimelineBase & {
      amountMinor: number;
      currency: string;
      kind: "refund";
      status: "pending" | "succeeded" | "failed";
      visibility: "internal";
    };

export type AdminOrderTimelinePage = {
  entries: AdminOrderTimelineEntry[];
  nextCursor: string | null;
};
