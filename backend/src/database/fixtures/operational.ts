import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";

export type OperationalFixtureDatabase = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rowCount: number | null; rows: T[] }>;
};

export type OperationalOrderReference = {
  capturedAmountCents: number;
  id: string;
  publicOrderNumber: string;
};

export type OperationalFixtureReferences = {
  adminUserId: string;
  awaitingAdminOrder: OperationalOrderReference;
  awaitingCustomerOrder: OperationalOrderReference;
  cancelledOrder: OperationalOrderReference;
  deliveredOrder: OperationalOrderReference & { shipmentId: string };
  failedRefundOrder: OperationalOrderReference;
  fullRefundOrder: OperationalOrderReference;
  manualReviewRefundOrder: OperationalOrderReference;
  partialRefundOrder: OperationalOrderReference;
  resolvedOrder: OperationalOrderReference;
};

export type OperationalOwnedRow = {
  canonicalFingerprint: string;
  fixtureKey: string;
  immutable: boolean;
  naturalKeyHash: string;
  rowId: string;
  tableName: string;
};

export type OperationalFixtureSeedInput = {
  claimOwnedRow(row: OperationalOwnedRow): Promise<void>;
  references: OperationalFixtureReferences;
};

export type OperationalFixtureSummary = {
  conversations: number;
  deliveryJobs: number;
  messages: number;
  messagingWebhooks: number;
  notificationIntents: number;
  paymentReconciliations: number;
  refundEffects: number;
  refunds: number;
  stripeWebhooks: number;
};

type ConversationFixture = {
  adminUnread: boolean;
  id: string;
  lastAdminAt: string | null;
  lastCustomerAt: string | null;
  lastMessageAt: string;
  orderId: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  status: "awaiting_admin" | "awaiting_customer" | "resolved";
  threadKey: string;
  version: number;
};

type MessageFixture = {
  body: string;
  channel: "email" | "internal_note";
  conversationId: string;
  createdAt: string;
  direction: "inbound" | "internal" | "outbound";
  failedAt: string | null;
  fromAddress: string | null;
  id: string;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  orderId: string;
  provider: string | null;
  providerError: string | null;
  providerEventId: string | null;
  providerMessageId: string | null;
  senderAuthenticatedUserId: string | null;
  senderType: "admin" | "customer" | "system";
  sentAt: string | null;
  status: "failed" | "sent";
  subject: string | null;
  toAddress: string | null;
};

type DeliveryJobFixture = {
  attemptCount: number;
  id: string;
  idempotencyKey: string;
  lastErrorCode: string | null;
  messageId: string;
  status: "failed" | "succeeded";
};

type NotificationIntentFixture = {
  failedAt: string | null;
  id: string;
  idempotencyKey: string;
  kind: "order.cancelled" | "order.delivered" | "refund.completed";
  lastFailureCode: string | null;
  messageId: string;
  orderId: string;
  payload: Record<string, unknown>;
  recipientAddress: string;
  sourceId: string;
  sourceType: "order" | "refund_operation" | "shipment";
  status: "failed" | "succeeded";
  succeededAt: string | null;
};

type PaymentFixture = {
  capturedAmountCents: number;
  latestChargeId: string;
  orderId: string;
  paymentIntentId: string;
  providerRefundedAmountCents: number;
};

type RefundFixture = {
  amountCents: number;
  clientIdempotencyKey: string;
  failedAt: string | null;
  failureCode: string | null;
  id: string;
  manualReviewRequired: boolean;
  notificationRequested: boolean;
  orderId: string;
  paymentIntentId: string;
  pendingReason: "unknown_outcome" | null;
  providerAttemptCount: number;
  providerRefundId: string | null;
  restockRequested: boolean;
  status: "failed" | "pending" | "succeeded";
  succeededAt: string | null;
};

type RefundEffectFixture = {
  failedAt: string | null;
  id: string;
  idempotencyKey: string;
  lastErrorCode: string | null;
  operationId: string;
  requested: boolean;
  status: "failed" | "not_requested" | "succeeded" | "unsupported";
  succeededAt: string | null;
  transactionalNotificationIntentId: string | null;
  type: "customer_notification" | "restock";
};

type StripeWebhookFixture = {
  attemptCount: number;
  eventId: string;
  eventType: string;
  id: string;
  lastErrorCode: string | null;
  manualReviewRequired: boolean;
  orderId: string;
  paymentIntentId: string;
  processedAt: string | null;
  projection: Record<string, unknown>;
  status: "exhausted" | "processed";
};

type MessagingWebhookFixture = {
  errorCode: string | null;
  id: string;
  messageId: string | null;
  processedAt: string;
  providerEventId: string;
  status: "processed" | "rejected";
};

export type OperationalFixturePlan = {
  conversations: ConversationFixture[];
  deliveryJobs: DeliveryJobFixture[];
  messages: MessageFixture[];
  messagingWebhooks: MessagingWebhookFixture[];
  notificationIntents: NotificationIntentFixture[];
  payments: PaymentFixture[];
  refundEffects: RefundEffectFixture[];
  refunds: RefundFixture[];
  stripeWebhooks: StripeWebhookFixture[];
};

const fixtureTimestamp = "2026-10-15T12:00:00.000Z";
const failedTimestamp = "2026-10-15T12:05:00.000Z";
const lookupUrl = "https://example.test/orders/lookup";
const fixtureEmail = "fixture-customer@example.test";

const ids = {
  conversations: {
    awaitingAdmin: "00000000-0085-4003-8000-000000000001",
    awaitingCustomer: "00000000-0085-4003-8000-000000000002",
    resolved: "00000000-0085-4003-8000-000000000003",
    cancelled: "00000000-0085-4003-8000-000000000004",
    delivered: "00000000-0085-4003-8000-000000000005",
    refund: "00000000-0085-4003-8000-000000000006"
  },
  messages: {
    inbound: "00000000-0085-4003-8000-000000001001",
    adminReply: "00000000-0085-4003-8000-000000001002",
    internalNote: "00000000-0085-4003-8000-000000001003",
    failedOutbound: "00000000-0085-4003-8000-000000001004",
    cancellation: "00000000-0085-4003-8000-000000001005",
    delivery: "00000000-0085-4003-8000-000000001006",
    refund: "00000000-0085-4003-8000-000000001007"
  },
  jobs: {
    adminReply: "00000000-0085-4003-8000-000000002001",
    failedOutbound: "00000000-0085-4003-8000-000000002002",
    cancellation: "00000000-0085-4003-8000-000000002003",
    delivery: "00000000-0085-4003-8000-000000002004",
    refund: "00000000-0085-4003-8000-000000002005"
  },
  intents: {
    cancellation: "00000000-0085-4003-8000-000000003001",
    delivery: "00000000-0085-4003-8000-000000003002",
    refund: "00000000-0085-4003-8000-000000003003"
  },
  refunds: {
    partial: "00000000-0085-4004-8000-000000004001",
    full: "00000000-0085-4004-8000-000000004002",
    failed: "00000000-0085-4004-8000-000000004003",
    manualReview: "00000000-0085-4004-8000-000000004004"
  },
  effects: {
    partialRestock: "00000000-0085-4004-8000-000000005001",
    partialNotification: "00000000-0085-4004-8000-000000005002",
    fullRestock: "00000000-0085-4004-8000-000000005003",
    fullNotification: "00000000-0085-4004-8000-000000005004",
    failedRestock: "00000000-0085-4004-8000-000000005005",
    failedNotification: "00000000-0085-4004-8000-000000005006",
    manualRestock: "00000000-0085-4004-8000-000000005007",
    manualNotification: "00000000-0085-4004-8000-000000005008"
  },
  stripeWebhooks: {
    processed: "00000000-0085-4004-8000-000000006001",
    exhausted: "00000000-0085-4004-8000-000000006002"
  },
  messagingWebhooks: {
    processed: "00000000-0085-4003-8000-000000007001",
    rejected: "00000000-0085-4003-8000-000000007002"
  }
} as const;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function hash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export class OperationalFixtureInvariantError extends Error {
  constructor(
    readonly code: string,
    readonly fixtureKey: string,
    readonly tableAlias: string,
  ) {
    super(`Operational fixture invariant failed (${code}).`);
    this.name = "OperationalFixtureInvariantError";
  }
}

function assertDistinctReferences(references: OperationalFixtureReferences) {
  const orderIds = [
    references.awaitingAdminOrder.id,
    references.awaitingCustomerOrder.id,
    references.cancelledOrder.id,
    references.deliveredOrder.id,
    references.failedRefundOrder.id,
    references.fullRefundOrder.id,
    references.manualReviewRefundOrder.id,
    references.partialRefundOrder.id,
    references.resolvedOrder.id
  ];
  if (new Set(orderIds).size !== orderIds.length) {
    throw new OperationalFixtureInvariantError(
      "OPERATIONAL_REFERENCE_COLLISION",
      "operational.references",
      "orders",
    );
  }
}

function message(input: Omit<MessageFixture, "createdAt" | "failedAt" | "fromAddress" | "metadata" | "provider" | "providerError" | "providerEventId" | "providerMessageId" | "senderAuthenticatedUserId" | "sentAt" | "subject" | "toAddress"> & Partial<MessageFixture>): MessageFixture {
  return {
    createdAt: fixtureTimestamp,
    failedAt: null,
    fromAddress: null,
    metadata: {},
    provider: null,
    providerError: null,
    providerEventId: null,
    providerMessageId: null,
    senderAuthenticatedUserId: null,
    sentAt: fixtureTimestamp,
    subject: null,
    toAddress: null,
    ...input
  };
}

export function buildOperationalFixturePlan(
  references: OperationalFixtureReferences,
): OperationalFixturePlan {
  assertDistinctReferences(references);
  const partialRefundAmount = Math.min(
    2500,
    Math.max(1, references.partialRefundOrder.capturedAmountCents - 1),
  );
  const failedRefundAmount = Math.min(
    1000,
    references.failedRefundOrder.capturedAmountCents,
  );
  const manualReviewAmount = Math.min(
    1200,
    references.manualReviewRefundOrder.capturedAmountCents,
  );
  const refundPayload = {
    currency: "usd",
    lookupUrl,
    publicOrderNumber: references.partialRefundOrder.publicOrderNumber,
    refundAmountMinor: partialRefundAmount
  };
  const conversations: ConversationFixture[] = [
    {
      adminUnread: true,
      id: ids.conversations.awaitingAdmin,
      lastAdminAt: null,
      lastCustomerAt: fixtureTimestamp,
      lastMessageAt: fixtureTimestamp,
      orderId: references.awaitingAdminOrder.id,
      resolvedAt: null,
      resolvedByUserId: null,
      status: "awaiting_admin",
      threadKey: `kapchi-fixture:${references.awaitingAdminOrder.id}`,
      version: 1
    },
    {
      adminUnread: false,
      id: ids.conversations.awaitingCustomer,
      lastAdminAt: fixtureTimestamp,
      lastCustomerAt: null,
      lastMessageAt: fixtureTimestamp,
      orderId: references.awaitingCustomerOrder.id,
      resolvedAt: null,
      resolvedByUserId: null,
      status: "awaiting_customer",
      threadKey: `kapchi-fixture:${references.awaitingCustomerOrder.id}`,
      version: 1
    },
    {
      adminUnread: false,
      id: ids.conversations.resolved,
      lastAdminAt: failedTimestamp,
      lastCustomerAt: null,
      lastMessageAt: failedTimestamp,
      orderId: references.resolvedOrder.id,
      resolvedAt: failedTimestamp,
      resolvedByUserId: references.adminUserId,
      status: "resolved",
      threadKey: `kapchi-fixture:${references.resolvedOrder.id}`,
      version: 2
    },
    ...[
      [ids.conversations.cancelled, references.cancelledOrder.id],
      [ids.conversations.delivered, references.deliveredOrder.id],
      [ids.conversations.refund, references.partialRefundOrder.id]
    ].map(([id, orderId]) => ({
      adminUnread: false,
      id,
      lastAdminAt: fixtureTimestamp,
      lastCustomerAt: null,
      lastMessageAt: fixtureTimestamp,
      orderId,
      resolvedAt: null,
      resolvedByUserId: null,
      status: "awaiting_customer" as const,
      threadKey: `kapchi-fixture:${orderId}`,
      version: 1
    }))
  ];

  const messages: MessageFixture[] = [
    message({
      body: "I have a question about my test order.",
      channel: "email",
      conversationId: ids.conversations.awaitingAdmin,
      direction: "inbound",
      fromAddress: fixtureEmail,
      id: ids.messages.inbound,
      idempotencyKey: "fixture:message:inbound",
      orderId: references.awaitingAdminOrder.id,
      provider: "fixture",
      providerEventId: "fixture-msg-event-processed",
      providerMessageId: "fixture-provider-message-inbound",
      senderType: "customer",
      status: "sent",
      toAddress: "support@example.test"
    }),
    message({
      body: "This is a deterministic test reply.",
      channel: "email",
      conversationId: ids.conversations.awaitingCustomer,
      direction: "outbound",
      fromAddress: "support@example.test",
      id: ids.messages.adminReply,
      idempotencyKey: "fixture:message:admin-reply",
      orderId: references.awaitingCustomerOrder.id,
      provider: "fixture",
      providerMessageId: "fixture-provider-message-admin-reply",
      senderAuthenticatedUserId: references.adminUserId,
      senderType: "admin",
      status: "sent",
      subject: "Test order update",
      toAddress: fixtureEmail
    }),
    message({
      body: "Internal fixture note. Do not expose to customers.",
      channel: "internal_note",
      conversationId: ids.conversations.resolved,
      direction: "internal",
      id: ids.messages.internalNote,
      idempotencyKey: "fixture:message:internal-note",
      orderId: references.resolvedOrder.id,
      senderAuthenticatedUserId: references.adminUserId,
      senderType: "admin",
      status: "sent"
    }),
    message({
      body: "This fixture message represents a terminal delivery failure.",
      channel: "email",
      conversationId: ids.conversations.resolved,
      direction: "outbound",
      failedAt: failedTimestamp,
      fromAddress: "support@example.test",
      id: ids.messages.failedOutbound,
      idempotencyKey: "fixture:message:failed-outbound",
      orderId: references.resolvedOrder.id,
      provider: "fixture",
      providerError: "MESSAGE_PROVIDER_REJECTED",
      senderType: "system",
      sentAt: null,
      status: "failed",
      subject: "Test delivery failure",
      toAddress: fixtureEmail
    }),
    message({
      body: "Your test order was cancelled.",
      channel: "email",
      conversationId: ids.conversations.cancelled,
      direction: "outbound",
      fromAddress: "orders@example.test",
      id: ids.messages.cancellation,
      idempotencyKey: `transactional-message:${ids.intents.cancellation}`,
      metadata: { transactionalNotificationIntentId: ids.intents.cancellation },
      orderId: references.cancelledOrder.id,
      provider: "fixture",
      providerMessageId: "fixture-provider-cancelled",
      senderType: "system",
      status: "sent",
      subject: "Test order cancelled",
      toAddress: fixtureEmail
    }),
    message({
      body: "Your test order was delivered.",
      channel: "email",
      conversationId: ids.conversations.delivered,
      direction: "outbound",
      failedAt: failedTimestamp,
      fromAddress: "orders@example.test",
      id: ids.messages.delivery,
      idempotencyKey: `transactional-message:${ids.intents.delivery}`,
      metadata: { transactionalNotificationIntentId: ids.intents.delivery },
      orderId: references.deliveredOrder.id,
      provider: "fixture",
      providerError: "MESSAGE_PROVIDER_REJECTED",
      senderType: "system",
      sentAt: null,
      status: "failed",
      subject: "Test order delivered",
      toAddress: fixtureEmail
    }),
    message({
      body: "A test refund of 2500 USD minor units was processed.",
      channel: "email",
      conversationId: ids.conversations.refund,
      direction: "outbound",
      fromAddress: "orders@example.test",
      id: ids.messages.refund,
      idempotencyKey: `transactional-message:${ids.intents.refund}`,
      metadata: { transactionalNotificationIntentId: ids.intents.refund },
      orderId: references.partialRefundOrder.id,
      provider: "fixture",
      providerMessageId: "fixture-provider-refund",
      senderType: "system",
      status: "sent",
      subject: "Test refund completed",
      toAddress: fixtureEmail
    })
  ];

  const deliveryJobs: DeliveryJobFixture[] = [
    { attemptCount: 1, id: ids.jobs.adminReply, idempotencyKey: "fixture:delivery:admin-reply", lastErrorCode: null, messageId: ids.messages.adminReply, status: "succeeded" },
    { attemptCount: 5, id: ids.jobs.failedOutbound, idempotencyKey: "fixture:delivery:failed-outbound", lastErrorCode: "MESSAGE_PROVIDER_REJECTED", messageId: ids.messages.failedOutbound, status: "failed" },
    { attemptCount: 1, id: ids.jobs.cancellation, idempotencyKey: `transactional-delivery:${ids.intents.cancellation}`, lastErrorCode: null, messageId: ids.messages.cancellation, status: "succeeded" },
    { attemptCount: 5, id: ids.jobs.delivery, idempotencyKey: `transactional-delivery:${ids.intents.delivery}`, lastErrorCode: "MESSAGE_PROVIDER_REJECTED", messageId: ids.messages.delivery, status: "failed" },
    { attemptCount: 1, id: ids.jobs.refund, idempotencyKey: `transactional-delivery:${ids.intents.refund}`, lastErrorCode: null, messageId: ids.messages.refund, status: "succeeded" }
  ];

  const notificationIntents: NotificationIntentFixture[] = [
    {
      failedAt: null,
      id: ids.intents.cancellation,
      idempotencyKey: `transactional:order-cancelled:${references.cancelledOrder.id}`,
      kind: "order.cancelled",
      lastFailureCode: null,
      messageId: ids.messages.cancellation,
      orderId: references.cancelledOrder.id,
      payload: { lookupUrl, publicOrderNumber: references.cancelledOrder.publicOrderNumber },
      recipientAddress: fixtureEmail,
      sourceId: references.cancelledOrder.id,
      sourceType: "order",
      status: "succeeded",
      succeededAt: fixtureTimestamp
    },
    {
      failedAt: failedTimestamp,
      id: ids.intents.delivery,
      idempotencyKey: `transactional:order-delivered:${references.deliveredOrder.shipmentId}`,
      kind: "order.delivered",
      lastFailureCode: "MESSAGE_PROVIDER_REJECTED",
      messageId: ids.messages.delivery,
      orderId: references.deliveredOrder.id,
      payload: { lookupUrl, publicOrderNumber: references.deliveredOrder.publicOrderNumber },
      recipientAddress: fixtureEmail,
      sourceId: references.deliveredOrder.shipmentId,
      sourceType: "shipment",
      status: "failed",
      succeededAt: null
    },
    {
      failedAt: null,
      id: ids.intents.refund,
      idempotencyKey: `transactional:refund-completed:${ids.refunds.partial}`,
      kind: "refund.completed",
      lastFailureCode: null,
      messageId: ids.messages.refund,
      orderId: references.partialRefundOrder.id,
      payload: refundPayload,
      recipientAddress: fixtureEmail,
      sourceId: ids.refunds.partial,
      sourceType: "refund_operation",
      status: "succeeded",
      succeededAt: fixtureTimestamp
    }
  ];

  const payments: PaymentFixture[] = [
    { capturedAmountCents: references.partialRefundOrder.capturedAmountCents, latestChargeId: "ch_test_fixture_partial", orderId: references.partialRefundOrder.id, paymentIntentId: "pi_test_fixture_partial", providerRefundedAmountCents: partialRefundAmount },
    { capturedAmountCents: references.fullRefundOrder.capturedAmountCents, latestChargeId: "ch_test_fixture_full", orderId: references.fullRefundOrder.id, paymentIntentId: "pi_test_fixture_full", providerRefundedAmountCents: references.fullRefundOrder.capturedAmountCents },
    { capturedAmountCents: references.failedRefundOrder.capturedAmountCents, latestChargeId: "ch_test_fixture_failed", orderId: references.failedRefundOrder.id, paymentIntentId: "pi_test_fixture_failed", providerRefundedAmountCents: 0 },
    { capturedAmountCents: references.manualReviewRefundOrder.capturedAmountCents, latestChargeId: "ch_test_fixture_manual", orderId: references.manualReviewRefundOrder.id, paymentIntentId: "pi_test_fixture_manual", providerRefundedAmountCents: 0 }
  ];

  const refunds: RefundFixture[] = [
    { amountCents: partialRefundAmount, clientIdempotencyKey: "fixture:refund:partial", failedAt: null, failureCode: null, id: ids.refunds.partial, manualReviewRequired: false, notificationRequested: true, orderId: references.partialRefundOrder.id, paymentIntentId: "pi_test_fixture_partial", pendingReason: null, providerAttemptCount: 1, providerRefundId: "re_test_fixture_partial", restockRequested: false, status: "succeeded", succeededAt: fixtureTimestamp },
    { amountCents: references.fullRefundOrder.capturedAmountCents, clientIdempotencyKey: "fixture:refund:full", failedAt: null, failureCode: null, id: ids.refunds.full, manualReviewRequired: false, notificationRequested: false, orderId: references.fullRefundOrder.id, paymentIntentId: "pi_test_fixture_full", pendingReason: null, providerAttemptCount: 1, providerRefundId: "re_test_fixture_full", restockRequested: true, status: "succeeded", succeededAt: fixtureTimestamp },
    { amountCents: failedRefundAmount, clientIdempotencyKey: "fixture:refund:failed", failedAt: failedTimestamp, failureCode: "card_declined", id: ids.refunds.failed, manualReviewRequired: false, notificationRequested: false, orderId: references.failedRefundOrder.id, paymentIntentId: "pi_test_fixture_failed", pendingReason: null, providerAttemptCount: 1, providerRefundId: "re_test_fixture_failed", restockRequested: false, status: "failed", succeededAt: null },
    { amountCents: manualReviewAmount, clientIdempotencyKey: "fixture:refund:manual-review", failedAt: null, failureCode: "ETIMEDOUT", id: ids.refunds.manualReview, manualReviewRequired: true, notificationRequested: false, orderId: references.manualReviewRefundOrder.id, paymentIntentId: "pi_test_fixture_manual", pendingReason: "unknown_outcome", providerAttemptCount: 1, providerRefundId: null, restockRequested: false, status: "pending", succeededAt: null }
  ];

  const refundEffects: RefundEffectFixture[] = [
    { failedAt: null, id: ids.effects.partialRestock, idempotencyKey: `refund-effect:${ids.refunds.partial}:restock`, lastErrorCode: null, operationId: ids.refunds.partial, requested: false, status: "not_requested", succeededAt: null, transactionalNotificationIntentId: null, type: "restock" },
    { failedAt: null, id: ids.effects.partialNotification, idempotencyKey: `refund-effect:${ids.refunds.partial}:notification`, lastErrorCode: null, operationId: ids.refunds.partial, requested: true, status: "succeeded", succeededAt: fixtureTimestamp, transactionalNotificationIntentId: ids.intents.refund, type: "customer_notification" },
    { failedAt: null, id: ids.effects.fullRestock, idempotencyKey: `refund-effect:${ids.refunds.full}:restock`, lastErrorCode: null, operationId: ids.refunds.full, requested: true, status: "unsupported", succeededAt: null, transactionalNotificationIntentId: null, type: "restock" },
    { failedAt: null, id: ids.effects.fullNotification, idempotencyKey: `refund-effect:${ids.refunds.full}:notification`, lastErrorCode: null, operationId: ids.refunds.full, requested: false, status: "not_requested", succeededAt: null, transactionalNotificationIntentId: null, type: "customer_notification" },
    { failedAt: null, id: ids.effects.failedRestock, idempotencyKey: `refund-effect:${ids.refunds.failed}:restock`, lastErrorCode: null, operationId: ids.refunds.failed, requested: false, status: "not_requested", succeededAt: null, transactionalNotificationIntentId: null, type: "restock" },
    { failedAt: null, id: ids.effects.failedNotification, idempotencyKey: `refund-effect:${ids.refunds.failed}:notification`, lastErrorCode: null, operationId: ids.refunds.failed, requested: false, status: "not_requested", succeededAt: null, transactionalNotificationIntentId: null, type: "customer_notification" },
    { failedAt: null, id: ids.effects.manualRestock, idempotencyKey: `refund-effect:${ids.refunds.manualReview}:restock`, lastErrorCode: null, operationId: ids.refunds.manualReview, requested: false, status: "not_requested", succeededAt: null, transactionalNotificationIntentId: null, type: "restock" },
    { failedAt: null, id: ids.effects.manualNotification, idempotencyKey: `refund-effect:${ids.refunds.manualReview}:notification`, lastErrorCode: null, operationId: ids.refunds.manualReview, requested: false, status: "not_requested", succeededAt: null, transactionalNotificationIntentId: null, type: "customer_notification" }
  ];

  const stripeWebhooks: StripeWebhookFixture[] = [
    {
      attemptCount: 1,
      eventId: "evt_test_fixture_refund_processed",
      eventType: "refund.updated",
      id: ids.stripeWebhooks.processed,
      lastErrorCode: null,
      manualReviewRequired: false,
      orderId: references.partialRefundOrder.id,
      paymentIntentId: "pi_test_fixture_partial",
      processedAt: fixtureTimestamp,
      projection: { eventId: "evt_test_fixture_refund_processed", kind: "refund", livemode: false, piiScrubbed: true, refundId: "re_test_fixture_partial" },
      status: "processed"
    },
    {
      attemptCount: 10,
      eventId: "evt_test_fixture_refund_exhausted",
      eventType: "refund.updated",
      id: ids.stripeWebhooks.exhausted,
      lastErrorCode: "WEBHOOK_ATTEMPTS_EXHAUSTED",
      manualReviewRequired: true,
      orderId: references.manualReviewRefundOrder.id,
      paymentIntentId: "pi_test_fixture_manual",
      processedAt: null,
      projection: { eventId: "evt_test_fixture_refund_exhausted", kind: "refund", livemode: false, piiScrubbed: true },
      status: "exhausted"
    }
  ];

  const messagingWebhooks: MessagingWebhookFixture[] = [
    { errorCode: null, id: ids.messagingWebhooks.processed, messageId: ids.messages.inbound, processedAt: fixtureTimestamp, providerEventId: "fixture-msg-event-processed", status: "processed" },
    { errorCode: "CONTACT_MISMATCH", id: ids.messagingWebhooks.rejected, messageId: null, processedAt: failedTimestamp, providerEventId: "fixture-msg-event-rejected", status: "rejected" }
  ];

  return { conversations, deliveryJobs, messages, messagingWebhooks, notificationIntents, payments, refundEffects, refunds, stripeWebhooks };
}

function ownership(
  tableName: string,
  fixtureKey: string,
  rowId: string,
  naturalKey: unknown,
  canonicalValue: unknown,
  immutable = true,
): OperationalOwnedRow {
  return {
    canonicalFingerprint: hash(canonicalValue),
    fixtureKey,
    immutable,
    naturalKeyHash: hash(naturalKey),
    rowId,
    tableName
  };
}

async function persist(
  db: OperationalFixtureDatabase,
  input: OperationalFixtureSeedInput,
  descriptor: OperationalOwnedRow,
  sql: string,
  values: readonly unknown[],
) {
  try {
    await input.claimOwnedRow(descriptor);
    await db.query(sql, values);
  } catch (error) {
    if (error instanceof OperationalFixtureInvariantError) throw error;
    throw new OperationalFixtureInvariantError(
      "OPERATIONAL_FIXTURE_WRITE_REJECTED",
      descriptor.fixtureKey,
      descriptor.tableName,
    );
  }
}

export async function seedOperationalFixtures(
  db: OperationalFixtureDatabase,
  input: OperationalFixtureSeedInput,
): Promise<OperationalFixtureSummary> {
  const plan = buildOperationalFixturePlan(input.references);

  for (const row of plan.conversations) {
    await persist(db, input, ownership("order_conversations", `operational.conversation.${row.id}`, row.id, { orderId: row.orderId, threadKey: row.threadKey }, row, false),
      `insert into order_conversations (
         id, order_id, thread_key, status, admin_unread, version,
         last_message_at, last_customer_message_at, last_admin_message_at,
         resolved_at, resolved_by_user_id, created_at, updated_at
       ) values ($1::uuid, $2::uuid, $3, $4::order_conversation_status, $5, $6,
                 $7::timestamptz, $8::timestamptz, $9::timestamptz,
                 $10::timestamptz, $11::uuid, $7::timestamptz, $7::timestamptz)
       on conflict (id) do nothing`,
      [row.id, row.orderId, row.threadKey, row.status, row.adminUnread, row.version, row.lastMessageAt, row.lastCustomerAt, row.lastAdminAt, row.resolvedAt, row.resolvedByUserId]);
  }

  for (const row of plan.messages) {
    await persist(db, input, ownership("order_messages", `operational.message.${row.id}`, row.id, { idempotencyKey: row.idempotencyKey }, row),
      `insert into order_messages (
         id, order_id, conversation_id, sender_type, sender_user_id,
         sender_authenticated_user_id, channel, direction, status,
         to_address, from_address, subject, body, provider,
         provider_message_id, provider_error, sent_at, created_at,
         idempotency_key, provider_event_id, attempt_count, failed_at, metadata
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::order_message_sender_type, null,
         $5::uuid, $6::message_channel, $7::message_direction, $8::message_status,
         $9, $10, $11, $12, $13, $14, $15, $16::timestamptz,
         $17::timestamptz, $18, $19, $20, $21::timestamptz, $22::jsonb
       ) on conflict (id) do nothing`,
      [row.id, row.orderId, row.conversationId, row.senderType, row.senderAuthenticatedUserId, row.channel, row.direction, row.status, row.toAddress, row.fromAddress, row.subject, row.body, row.provider, row.providerMessageId, row.providerError, row.sentAt, row.createdAt, row.idempotencyKey, row.providerEventId, row.status === "failed" ? 5 : 1, row.failedAt, JSON.stringify(row.metadata)]);
  }

  for (const row of plan.deliveryJobs) {
    await persist(db, input, ownership("message_delivery_jobs", `operational.delivery.${row.id}`, row.id, { idempotencyKey: row.idempotencyKey, messageId: row.messageId }, row),
      `insert into message_delivery_jobs (
         id, order_message_id, status, idempotency_key, attempt_count,
         max_attempts, next_attempt_at, lease_owner, lease_expires_at,
         last_error_code, created_at, updated_at
       ) values ($1::uuid, $2::uuid, $3::message_delivery_job_status, $4, $5,
                 5, $6::timestamptz, null, null, $7, $6::timestamptz, $6::timestamptz)
       on conflict (id) do nothing`,
      [row.id, row.messageId, row.status, row.idempotencyKey, row.attemptCount, fixtureTimestamp, row.lastErrorCode]);
  }

  for (const row of plan.notificationIntents) {
    await persist(db, input, ownership("transactional_notification_intents", `operational.intent.${row.id}`, row.id, { idempotencyKey: row.idempotencyKey, kind: row.kind, sourceId: row.sourceId }, row),
      `insert into transactional_notification_intents (
         id, order_id, kind, idempotency_key, source_type, source_id,
         payload_version, payload, payload_hash, recipient_channel,
         recipient_address, recipient_failure_code, status,
         materialization_attempt_count, max_materialization_attempts,
         next_attempt_at, lease_owner, lease_expires_at, last_failure_code,
         order_message_id, queued_at, succeeded_at, failed_at, created_at, updated_at
       ) values (
         $1::uuid, $2::uuid, $3::transactional_notification_kind, $4, $5, $6::uuid,
         1, $7::jsonb, $8, 'email', $9, null,
         $10::transactional_notification_intent_status, 1, 5,
         $11::timestamptz, null, null, $12, $13::uuid,
         $11::timestamptz, $14::timestamptz, $15::timestamptz,
         $11::timestamptz, $11::timestamptz
       ) on conflict (id) do nothing`,
      [row.id, row.orderId, row.kind, row.idempotencyKey, row.sourceType, row.sourceId, JSON.stringify(row.payload), hash(row.payload), row.recipientAddress, row.status, fixtureTimestamp, row.lastFailureCode, row.messageId, row.succeededAt, row.failedAt]);
  }

  for (const row of plan.payments) {
    await persist(db, input, ownership("payment_reconciliation_state", `operational.payment.${row.orderId}`, row.orderId, { paymentIntentId: row.paymentIntentId }, row, false),
      `insert into payment_reconciliation_state (
         order_id, payment_intent_id, provider_account_id, livemode,
         latest_charge_id, stripe_api_version, captured_amount_cents,
         provider_refunded_amount_cents, currency, provider_payment_status,
         reconciliation_status, last_reconciliation_error_code,
         last_reconciled_at, created_at, updated_at
       ) values ($1::uuid, $2, 'acct_test_fixture', false, $3,
                 '2026-02-25.clover', $4, $5, 'usd', 'succeeded',
                 'current', null, $6::timestamptz, $6::timestamptz, $6::timestamptz)
       on conflict (order_id) do nothing`,
      [row.orderId, row.paymentIntentId, row.latestChargeId, row.capturedAmountCents, row.providerRefundedAmountCents, fixtureTimestamp]);
  }

  for (const row of plan.refunds) {
    await persist(db, input, ownership("refund_operations", `operational.refund.${row.id}`, row.id, { clientIdempotencyKey: row.clientIdempotencyKey, providerRefundId: row.providerRefundId }, row),
      `insert into refund_operations (
         id, order_id, payment_intent_id, provider_account_id, livemode,
         amount_cents, currency, reason_code, reason_note, actor_user_id,
         actor_auth_subject, origin, status, pending_reason, provider_refund_id,
         client_idempotency_key, provider_idempotency_key, request_fingerprint,
         provider_failure_code, provider_created_at, succeeded_at, failed_at,
         provider_attempt_count, provider_attempt_started_at,
         dispatch_ever_claimed, dispatch_lease_owner, dispatch_lease_expires_at,
         reconciliation_attempt_count, last_reconciliation_attempt_at,
         next_reconciliation_at, manual_review_required, restock_requested,
         notification_requested, created_at, updated_at
       ) values (
         $1::uuid, $2::uuid, $3, 'acct_test_fixture', false,
         $4, 'usd', 'requested_by_customer', 'Synthetic test fixture', $5::uuid,
         'fixture-admin-subject', 'kapchi', $6::refund_status,
         $7::refund_pending_reason, $8, $9, $10, $11, $12,
         $13::timestamptz, $14::timestamptz, $15::timestamptz,
         $16, case when $16 > 0 then $17::timestamptz else null end,
         $18, null, null, 0, null, null, $19, $20, $21,
         $17::timestamptz, $17::timestamptz
       ) on conflict (id) do nothing`,
      [row.id, row.orderId, row.paymentIntentId, row.amountCents, input.references.adminUserId, row.status, row.pendingReason, row.providerRefundId, row.clientIdempotencyKey, `fixture:provider:${row.id}`, hash({ id: row.id, orderId: row.orderId }), row.failureCode, row.status === "failed" ? null : fixtureTimestamp, row.succeededAt, row.failedAt, row.providerAttemptCount, fixtureTimestamp, row.providerAttemptCount > 0, row.manualReviewRequired, row.restockRequested, row.notificationRequested]);
  }

  for (const row of plan.refundEffects) {
    await persist(db, input, ownership("refund_effects", `operational.refund-effect.${row.id}`, row.id, { idempotencyKey: row.idempotencyKey, operationId: row.operationId, type: row.type }, row),
      `insert into refund_effects (
         id, refund_operation_id, effect_type, requested, status,
         idempotency_key, attempt_count, last_error_code, next_attempt_at,
         succeeded_at, failed_at, transactional_notification_intent_id,
         created_at, updated_at
       ) values ($1::uuid, $2::uuid, $3::refund_effect_type, $4,
                 $5::refund_effect_status, $6, $7, $8, null,
                 $9::timestamptz, $10::timestamptz, $11::uuid,
                 $12::timestamptz, $12::timestamptz)
       on conflict (id) do nothing`,
      [row.id, row.operationId, row.type, row.requested, row.status, row.idempotencyKey, row.status === "failed" ? 5 : row.status === "succeeded" ? 1 : 0, row.lastErrorCode, row.succeededAt, row.failedAt, row.transactionalNotificationIntentId, fixtureTimestamp]);
  }

  for (const row of plan.stripeWebhooks) {
    await persist(db, input, ownership("stripe_webhook_events", `operational.stripe-webhook.${row.id}`, row.id, { eventId: row.eventId }, row),
      `insert into stripe_webhook_events (
         id, stripe_event_id, event_type, api_version, livemode, order_id,
         stripe_checkout_session_id, stripe_payment_intent_id,
         processing_status, processing_error, payload, received_at,
         processed_at, event_projection, projection_version,
         raw_payload_sha256, provider_account_id, livemode_verified,
         attempt_count, next_attempt_at, lease_owner, lease_expires_at,
         last_error_code, manual_review_required, created_at, updated_at
       ) values (
         $1::uuid, $2, $3, '2026-02-25.clover', false, $4::uuid,
         null, $5, $6::stripe_webhook_processing_status, null, null,
         $7::timestamptz, $8::timestamptz, $9::jsonb, 1,
         $10, 'acct_test_fixture', true, $11, null, null, null,
         $12, $13, $7::timestamptz, $7::timestamptz
       ) on conflict (id) do nothing`,
      [row.id, row.eventId, row.eventType, row.orderId, row.paymentIntentId, row.status, fixtureTimestamp, row.processedAt, JSON.stringify(row.projection), hash(row.projection), row.attemptCount, row.lastErrorCode, row.manualReviewRequired]);
  }

  for (const row of plan.messagingWebhooks) {
    await persist(db, input, ownership("messaging_webhook_events", `operational.messaging-webhook.${row.id}`, row.id, { provider: "fixture", providerEventId: row.providerEventId }, row),
      `insert into messaging_webhook_events (
         id, provider, provider_event_id, payload_hash, status,
         order_message_id, error_code, received_at, processed_at
       ) values ($1::uuid, 'fixture', $2, $3,
                 $4::messaging_webhook_status, $5::uuid, $6,
                 $7::timestamptz, $8::timestamptz)
       on conflict (id) do nothing`,
      [row.id, row.providerEventId, hash({ eventId: row.providerEventId }), row.status, row.messageId, row.errorCode, fixtureTimestamp, row.processedAt]);
  }

  await verifyOperationalFixtures(db, input.references);
  return {
    conversations: plan.conversations.length,
    deliveryJobs: plan.deliveryJobs.length,
    messages: plan.messages.length,
    messagingWebhooks: plan.messagingWebhooks.length,
    notificationIntents: plan.notificationIntents.length,
    paymentReconciliations: plan.payments.length,
    refundEffects: plan.refundEffects.length,
    refunds: plan.refunds.length,
    stripeWebhooks: plan.stripeWebhooks.length
  };
}

type VerificationRow = QueryResultRow & {
  invalid_count: number;
};

async function assertZero(
  db: OperationalFixtureDatabase,
  code: string,
  tableAlias: string,
  fixtureKey: string,
  sql: string,
  values: readonly unknown[],
) {
  const result = await db.query<VerificationRow>(sql, values);
  if (Number(result.rows[0]?.invalid_count ?? 0) !== 0) {
    throw new OperationalFixtureInvariantError(code, fixtureKey, tableAlias);
  }
}

export async function verifyOperationalFixtures(
  db: OperationalFixtureDatabase,
  references: OperationalFixtureReferences,
): Promise<OperationalFixtureSummary> {
  const plan = buildOperationalFixturePlan(references);
  const refundIds = plan.refunds.map((row) => row.id);
  const orderIds = [
    references.awaitingAdminOrder.id,
    references.awaitingCustomerOrder.id,
    references.cancelledOrder.id,
    references.deliveredOrder.id,
    references.failedRefundOrder.id,
    references.fullRefundOrder.id,
    references.manualReviewRefundOrder.id,
    references.partialRefundOrder.id,
    references.resolvedOrder.id
  ];

  await assertZero(db, "OPERATIONAL_REFUND_WORK_ELIGIBLE", "refunds", "operational.refunds",
    `select count(*)::integer as invalid_count from refund_operations
      where id = any($1::uuid[]) and (
        (status = 'pending' and pending_reason = 'reserved') or
        (status = 'pending' and not manual_review_required and coalesce(next_reconciliation_at, created_at) <= now()) or
        dispatch_lease_owner is not null or reconciliation_lease_owner is not null or livemode
      )`, [refundIds]);
  await assertZero(db, "OPERATIONAL_REFUND_EFFECT_WORK_ELIGIBLE", "refund_effects", "operational.refund-effects",
    `select count(*)::integer as invalid_count from refund_effects
      where refund_operation_id = any($1::uuid[]) and status = 'pending'`, [refundIds]);
  await assertZero(db, "OPERATIONAL_MESSAGE_WORK_ELIGIBLE", "messages", "operational.messages",
    `select count(*)::integer as invalid_count from message_delivery_jobs
      where id = any($1::uuid[]) and status in ('pending', 'retryable', 'leased')`,
    [plan.deliveryJobs.map((row) => row.id)]);
  await assertZero(db, "OPERATIONAL_NOTIFICATION_WORK_ELIGIBLE", "notifications", "operational.notifications",
    `select count(*)::integer as invalid_count from transactional_notification_intents
      where id = any($1::uuid[]) and status in ('pending', 'retryable', 'leased')`,
    [plan.notificationIntents.map((row) => row.id)]);
  await assertZero(db, "OPERATIONAL_WEBHOOK_WORK_ELIGIBLE", "stripe-webhooks", "operational.stripe-webhooks",
    `select count(*)::integer as invalid_count from stripe_webhook_events
      where id = any($1::uuid[]) and (
        processing_status in ('received', 'processing', 'retryable', 'unmatched') or
        next_attempt_at is not null or lease_owner is not null or lease_expires_at is not null or
        livemode or livemode_verified is distinct from true
      )`, [plan.stripeWebhooks.map((row) => row.id)]);
  await assertZero(db, "OPERATIONAL_MESSAGING_WEBHOOK_NOT_TERMINAL", "messaging-webhooks", "operational.messaging-webhooks",
    `select count(*)::integer as invalid_count from messaging_webhook_events
      where id = any($1::uuid[]) and (status = 'received' or processed_at is null)`,
    [plan.messagingWebhooks.map((row) => row.id)]);
  await assertZero(db, "OPERATIONAL_NOTIFICATION_COVERAGE_MISSING", "notifications", "operational.lifecycle-notifications",
    `select count(*)::integer as invalid_count from (
       select $1::uuid as source_id, $2::text as idempotency_key
       union all
       select $3::uuid, $4::text
     ) expected
     where not exists (
       select 1 from transactional_notification_intents intents
        where intents.source_id = expected.source_id
          and intents.idempotency_key = expected.idempotency_key
          and intents.status in ('succeeded', 'failed')
     )`, [
      references.cancelledOrder.id,
      `transactional:order-cancelled:${references.cancelledOrder.id}`,
      references.deliveredOrder.shipmentId,
      `transactional:order-delivered:${references.deliveredOrder.shipmentId}`
    ]);
  await assertZero(db, "OPERATIONAL_POLICY_BOUNDARY_VIOLATED", "orders", "operational.policy-boundary",
    `select (
       (select count(*) from orders where id = any($1::uuid[]) and stripe_checkout_session_id is not null) +
       (select count(*) from order_policy_assertions where order_id = any($1::uuid[]))
     )::integer as invalid_count`, [orderIds]);
  await assertZero(db, "OPERATIONAL_REFUND_RECONCILIATION_INVALID", "payment-reconciliation", "operational.payment-reconciliation",
    `select count(*)::integer as invalid_count
       from payment_reconciliation_state payments
      where payments.order_id = any($1::uuid[]) and (
        payments.livemode or payments.reconciliation_status <> 'current' or
        payments.provider_refunded_amount_cents <> coalesce((
          select sum(refunds.amount_cents)::integer from refund_operations refunds
           where refunds.order_id = payments.order_id and refunds.status = 'succeeded'
        ), 0)
      )`, [plan.payments.map((row) => row.orderId)]);

  const counts = await db.query<QueryResultRow & Record<keyof OperationalFixtureSummary, number>>(
    `select
       (select count(*)::integer from order_conversations where id = any($1::uuid[])) as conversations,
       (select count(*)::integer from order_messages where id = any($2::uuid[])) as messages,
       (select count(*)::integer from message_delivery_jobs where id = any($3::uuid[])) as "deliveryJobs",
       (select count(*)::integer from transactional_notification_intents where id = any($4::uuid[])) as "notificationIntents",
       (select count(*)::integer from payment_reconciliation_state where order_id = any($5::uuid[])) as "paymentReconciliations",
       (select count(*)::integer from refund_operations where id = any($6::uuid[])) as refunds,
       (select count(*)::integer from refund_effects where id = any($7::uuid[])) as "refundEffects",
       (select count(*)::integer from stripe_webhook_events where id = any($8::uuid[])) as "stripeWebhooks",
       (select count(*)::integer from messaging_webhook_events where id = any($9::uuid[])) as "messagingWebhooks"`,
    [
      plan.conversations.map((row) => row.id),
      plan.messages.map((row) => row.id),
      plan.deliveryJobs.map((row) => row.id),
      plan.notificationIntents.map((row) => row.id),
      plan.payments.map((row) => row.orderId),
      refundIds,
      plan.refundEffects.map((row) => row.id),
      plan.stripeWebhooks.map((row) => row.id),
      plan.messagingWebhooks.map((row) => row.id)
    ],
  );
  const summary = counts.rows[0] as OperationalFixtureSummary | undefined;
  const expected: OperationalFixtureSummary = {
    conversations: plan.conversations.length,
    deliveryJobs: plan.deliveryJobs.length,
    messages: plan.messages.length,
    messagingWebhooks: plan.messagingWebhooks.length,
    notificationIntents: plan.notificationIntents.length,
    paymentReconciliations: plan.payments.length,
    refundEffects: plan.refundEffects.length,
    refunds: plan.refunds.length,
    stripeWebhooks: plan.stripeWebhooks.length
  };
  if (!summary || Object.entries(expected).some(([key, count]) => Number(summary[key as keyof OperationalFixtureSummary]) !== count)) {
    throw new OperationalFixtureInvariantError(
      "OPERATIONAL_FIXTURE_COUNT_MISMATCH",
      "operational.summary",
      "operational",
    );
  }
  return expected;
}

export const operationalFixtureIds = ids;
