export const REFUND_PERMISSION = "orders:refund";
export const REFUND_RESOLVE_PERMISSION = "orders:refund:resolve";
export const REFUND_FINGERPRINT_VERSION = 1;

export type RefundReasonCode =
  | "requested_by_customer"
  | "duplicate"
  | "fraudulent"
  | "other";

export type RefundPendingReason =
  | "reserved"
  | "provider_pending"
  | "requires_action"
  | "unknown_outcome"
  | "provider_conflict";

export type RefundStatus = "pending" | "succeeded" | "failed";

export type RefundRequest = {
  amountCents?: number;
  currency: string;
  reasonCode: RefundReasonCode;
  reasonNote?: string | null;
  restockRequested: boolean;
  notificationRequested: boolean;
};

export type RefundActor = {
  authSubject: string;
  userId: string;
};

export type ProviderRefund = {
  amountCents: number;
  chargeId: string | null;
  createdAt: Date;
  currency: string;
  failureCode: string | null;
  id: string;
  livemode: boolean;
  metadata: {
    operationId?: string;
    orderId?: string;
  };
  paymentIntentId: string | null;
  status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
};

export type ProviderPaymentSnapshot = {
  apiVersion: string | null;
  capturedAmountCents: number;
  currency: string;
  latestChargeId: string | null;
  livemode: boolean;
  paymentIntentId: string;
  providerAccountId: string;
  providerPaymentStatus: string;
  refunds: ProviderRefund[];
};

export type RefundOperation = {
  amountCents: number;
  clientIdempotencyKey: string;
  createdAt: string;
  currency: string;
  failedAt: string | null;
  failureCode: string | null;
  id: string;
  manualReviewRequired: boolean;
  nextReconciliationAt: string | null;
  notificationRequested: boolean;
  orderId: string;
  pendingReason: RefundPendingReason | null;
  providerRefundId: string | null;
  restockRequested: boolean;
  status: RefundStatus;
  succeededAt: string | null;
};

export type RefundSummary = {
  capabilities: {
    customerNotificationExecution: boolean;
    itemLevelAllocation: boolean;
    restockExecution: boolean;
  };
  capturedAmountCents: number;
  currency: string;
  lastReconciledAt: string;
  operations: RefundOperation[];
  overcommittedReservedAmountCents: number;
  pendingAmountCents: number;
  reconciliationStatus: "current" | "stale" | "failed" | "conflicted";
  remainingRefundableAmountCents: number;
  succeededAmountCents: number;
};

