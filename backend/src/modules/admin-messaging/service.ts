import { randomUUID } from "node:crypto";
import { canonicalMessageFailureCode } from "./errors.js";
import type { MessageProvider } from "./provider.js";
import type { AdminMessagingRepository } from "./repository.js";
import type {
  ConversationQuery,
  MessagingActor,
  MessagingWebhookInput,
  QueueNoteInput,
  QueueReplyInput,
  TransactionalNotificationQuery,
  TransactionalNotificationView
} from "./types.js";

export type MessagingRepositoryPort = Pick<
  AdminMessagingRepository,
  | "addNote"
  | "claimDeliveryJobs"
  | "completeDelivery"
  | "detail"
  | "failDelivery"
  | "list"
  | "queueReply"
  | "receiveWebhook"
  | "resolveActor"
  | "scheduleRefundNotification"
  | "scheduleRefundNotifications"
  | "updateConversation"
>;

export type MessagingObserver = {
  error(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
};

export type NotificationPhaseResult = {
  attempted: number;
  failed?: number;
  queued?: number;
  retrying?: number;
  scheduled?: number;
};

export type TransactionalNotificationOperations = {
  list(query: TransactionalNotificationQuery): Promise<{
    notifications: TransactionalNotificationView[];
  }>;
  listForOrder(orderId: string): Promise<TransactionalNotificationView[]>;
  materializeIntents(
    limit: number,
    leaseOwner: string,
    senders: SenderConfig,
  ): Promise<NotificationPhaseResult>;
  promoteRefundEffect(operationId: string): Promise<boolean>;
  promoteRefundEffects(limit: number): Promise<NotificationPhaseResult>;
  reconcileLifecycle(limit: number): Promise<NotificationPhaseResult>;
};

const noopObserver: MessagingObserver = {
  error() {},
  info() {},
  warn() {}
};

type SenderConfig = {
  email?: string;
  sms?: string;
};

export class AdminMessagingService {
  constructor(
    private readonly repository: MessagingRepositoryPort,
    private readonly provider: MessageProvider,
    private readonly senders: SenderConfig,
    private readonly observer: MessagingObserver = noopObserver,
    private readonly notifications?: TransactionalNotificationOperations,
  ) {}

  resolveActor(authSubject: string) {
    return this.repository.resolveActor(authSubject);
  }

  list(query: ConversationQuery) {
    return this.repository.list(query);
  }

  async detail(orderId: string) {
    const [detail, transactionalNotifications] = await Promise.all([
      this.repository.detail(orderId),
      this.notifications?.listForOrder(orderId) ?? Promise.resolve([])
    ]);
    return { ...detail, transactionalNotifications };
  }

  listNotifications(query: TransactionalNotificationQuery) {
    if (!this.notifications) return Promise.resolve({ notifications: [] });
    return this.notifications.list(query);
  }

  queueReply(
    orderId: string,
    actor: MessagingActor,
    input: QueueReplyInput,
    idempotencyKey: string,
  ) {
    return this.repository.queueReply(
      orderId,
      actor,
      input,
      idempotencyKey,
      this.senders,
    );
  }

  addNote(
    orderId: string,
    actor: MessagingActor,
    input: QueueNoteInput,
    idempotencyKey: string,
  ) {
    return this.repository.addNote(orderId, actor, input, idempotencyKey);
  }

  updateConversation(
    orderId: string,
    actor: MessagingActor,
    action: "read" | "reopen" | "resolve",
    expectedVersion: number,
  ) {
    return this.repository.updateConversation(
      orderId,
      actor,
      action,
      expectedVersion,
    );
  }

  receiveWebhook(
    provider: string,
    input: MessagingWebhookInput,
    payloadHash: string,
  ) {
    return this.repository.receiveWebhook(provider, input, payloadHash);
  }

  async scheduleRefundNotification(operationId: string) {
    try {
      const scheduled = this.notifications
        ? await this.notifications.promoteRefundEffect(operationId)
        : await this.repository.scheduleRefundNotification(operationId, this.senders);
      this.observer.info("message.refund_notification.scheduled", {
        operationId,
        resultCode: scheduled ? "SCHEDULED" : "NOT_ELIGIBLE"
      });
      return scheduled;
    } catch {
      this.observer.error("message.refund_notification.failed", {
        operationId,
        resultCode: "SCHEDULING_FAILED"
      });
      return false;
    }
  }

  private async runNotificationPhase(
    event: string,
    operation: () => Promise<NotificationPhaseResult>,
  ) {
    try {
      const result = await operation();
      this.observer.info(event, {
        attempted: result.attempted,
        failed: result.failed ?? 0,
        queued: result.queued ?? 0,
        resultCode: "COMPLETED",
        retrying: result.retrying ?? 0,
        scheduled: result.scheduled ?? 0
      });
      return result;
    } catch {
      const result = { attempted: 0, failed: 1 };
      this.observer.error(event, {
        ...result,
        resultCode: "PHASE_FAILED"
      });
      return result;
    }
  }

  async runDelivery(limit = 50) {
    const lifecycle = await this.runNotificationPhase(
      "transactional_notification.reconciliation.completed",
      () => this.notifications
        ? this.notifications.reconcileLifecycle(limit)
        : Promise.resolve({ attempted: 0, scheduled: 0 }),
    );
    const refundNotifications = await this.runNotificationPhase(
      "transactional_notification.refund_promotion.completed",
      () => this.notifications
        ? this.notifications.promoteRefundEffects(limit)
        : this.repository.scheduleRefundNotifications(limit, this.senders),
    );
    const materializationLeaseOwner = randomUUID();
    const materialization = await this.runNotificationPhase(
      "transactional_notification.materialization.completed",
      () => this.notifications
        ? this.notifications.materializeIntents(
            limit,
            materializationLeaseOwner,
            this.senders,
          )
        : Promise.resolve({ attempted: 0, queued: 0 }),
    );
    const deliveryLeaseOwner = randomUUID();
    const jobs = await this.repository.claimDeliveryJobs(limit, deliveryLeaseOwner);
    let delivered = 0;
    let failed = 0;
    let retrying = 0;

    for (const job of jobs) {
      try {
        const result = await this.provider.send(job.message);
        const completed = await this.repository.completeDelivery(
          job,
          deliveryLeaseOwner,
          result,
        );
        if (!completed) {
          this.observer.warn("message.delivery.lease_lost", {
            attemptCount: job.attemptCount,
            intentId: job.intentId ?? undefined,
            kind: job.kind ?? undefined,
            messageId: job.message.messageId,
            resultCode: "MESSAGE_LEASE_LOST"
          });
          continue;
        }
        delivered += 1;
        this.observer.info(
          job.intentId
            ? "transactional_notification.delivery.succeeded"
            : "message.delivery.succeeded",
          {
            attemptCount: job.attemptCount,
            channel: job.message.channel,
            intentId: job.intentId ?? undefined,
            kind: job.kind ?? undefined,
            messageId: job.message.messageId,
            resultCode: "SENT"
          },
        );
      } catch (error) {
        const providerError = error as { code?: unknown; retryable?: unknown };
        const code = canonicalMessageFailureCode(providerError.code);
        const retryable = providerError.retryable === true;
        const recorded = await this.repository.failDelivery(
          job,
          deliveryLeaseOwner,
          code,
          retryable,
        );
        if (!recorded) {
          this.observer.warn("message.delivery.lease_lost", {
            attemptCount: job.attemptCount,
            intentId: job.intentId ?? undefined,
            kind: job.kind ?? undefined,
            messageId: job.message.messageId,
            resultCode: "MESSAGE_LEASE_LOST"
          });
          continue;
        }
        if (retryable && job.attemptCount < job.maxAttempts) retrying += 1;
        else failed += 1;
        this.observer[retryable ? "warn" : "error"](
          job.intentId
            ? "transactional_notification.delivery.failed"
            : "message.delivery.failed",
          {
            attemptCount: job.attemptCount,
            channel: job.message.channel,
            intentId: job.intentId ?? undefined,
            kind: job.kind ?? undefined,
            messageId: job.message.messageId,
            resultCode: code,
            retryable
          },
        );
      }
    }

    return {
      attempted: jobs.length,
      delivered,
      failed,
      lifecycle,
      materialization,
      refundNotifications,
      retrying
    };
  }
}
