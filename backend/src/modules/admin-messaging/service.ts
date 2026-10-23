import { randomUUID } from "node:crypto";
import type { MessageProvider } from "./provider.js";
import type { AdminMessagingRepository } from "./repository.js";
import type {
  ConversationQuery,
  MessagingActor,
  MessagingWebhookInput,
  QueueNoteInput,
  QueueReplyInput
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
  ) {}

  resolveActor(authSubject: string) {
    return this.repository.resolveActor(authSubject);
  }

  list(query: ConversationQuery) {
    return this.repository.list(query);
  }

  detail(orderId: string) {
    return this.repository.detail(orderId);
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
      const scheduled = await this.repository.scheduleRefundNotification(
        operationId,
        this.senders,
      );
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

  async runDelivery(limit = 50) {
    const scheduled = await this.repository.scheduleRefundNotifications(
      limit,
      this.senders,
    );
    const leaseOwner = randomUUID();
    const jobs = await this.repository.claimDeliveryJobs(limit, leaseOwner);
    let delivered = 0;
    let failed = 0;
    let retrying = 0;

    for (const job of jobs) {
      try {
        const result = await this.provider.send(job.message);
        await this.repository.completeDelivery(job, leaseOwner, result);
        delivered += 1;
        this.observer.info("message.delivery.succeeded", {
          attemptCount: job.attemptCount,
          channel: job.message.channel,
          messageId: job.message.messageId,
          resultCode: "SENT"
        });
      } catch (error) {
        const providerError = error as { code?: unknown; retryable?: unknown };
        const code = typeof providerError.code === "string"
          ? providerError.code
          : "MESSAGE_PROVIDER_UNEXPECTED";
        const retryable = providerError.retryable === true;
        await this.repository.failDelivery(
          job,
          leaseOwner,
          code,
          retryable,
        );
        if (retryable && job.attemptCount < job.maxAttempts) retrying += 1;
        else failed += 1;
        this.observer[retryable ? "warn" : "error"]("message.delivery.failed", {
          attemptCount: job.attemptCount,
          channel: job.message.channel,
          messageId: job.message.messageId,
          resultCode: code
        });
      }
    }

    return {
      attempted: jobs.length,
      delivered,
      failed,
      refundNotifications: scheduled,
      retrying
    };
  }
}
