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

export type AdminOrderDetail = AdminOrderSummary & {
  cancelledAt: string | null;
  completedAt: string | null;
  contactSnapshot: CustomerSnapshot;
  items: AdminOrderItem[];
  paidAt: string | null;
  shippedAt: string | null;
  shipping: { address: Record<string, unknown> | null; name: string | null };
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
