import type { PoolClient } from "pg";

export type NotificationKind =
  | "order.confirmed"
  | "order.cancelled"
  | "refund.completed"
  | "order.shipped"
  | "order.delivered";

export type NotificationIntentStatus =
  | "pending"
  | "leased"
  | "retryable"
  | "queued"
  | "succeeded"
  | "failed";

export type NotificationChannel = "email" | "sms";

export type NotificationItemSummary = {
  quantity: number;
  title: string;
};

export type TransactionalNotificationPayload = {
  additionalItemCount?: number;
  carrier?: string | null;
  currency?: string;
  items?: NotificationItemSummary[];
  lookupUrl: string;
  publicOrderNumber: string;
  refundAmountMinor?: number;
  totalAmountMinor?: number;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
};

export type RecipientSnapshot = {
  address: string | null;
  channel: NotificationChannel | null;
  failureCode:
    | "MESSAGE_CONTACT_UNAVAILABLE"
    | "MESSAGE_SMS_CONSENT_UNAVAILABLE"
    | null;
};

export type Queryable = Pick<PoolClient, "query">;

export type ClaimedNotificationIntent = {
  id: string;
  kind: NotificationKind;
  leaseOwner: string;
  materializationAttemptCount: number;
  orderId: string;
  payload: TransactionalNotificationPayload;
  recipientChannel: NotificationChannel | null;
  recipientFailureCode: RecipientSnapshot["failureCode"];
};

export type SafeNotificationStatus = {
  channel: NotificationChannel | null;
  createdAt: string;
  deliveryAttemptCount: number;
  failedAt: string | null;
  failureCode: string | null;
  id: string;
  kind: NotificationKind;
  materializationAttemptCount: number;
  publicOrderNumber: string;
  queuedAt: string | null;
  state: NotificationIntentStatus;
  succeededAt: string | null;
  updatedAt: string;
};

export type NotificationStatusFilters = {
  failureCode?: string;
  kind?: NotificationKind;
  limit?: number;
  state?: NotificationIntentStatus;
};

export type RenderedNotification = {
  body: string;
  subject: string;
};
