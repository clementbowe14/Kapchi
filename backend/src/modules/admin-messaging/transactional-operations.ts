import type { Pool } from "pg";
import {
  canonicalMessageFailureCode,
  type MessageFailureCode
} from "./errors.js";
import type {
  NotificationPhaseResult,
  TransactionalNotificationOperations
} from "./service.js";
import { TransactionalNotificationRepository } from "../transactional-notifications/repository.js";
import { TransactionalNotificationWorkerService } from "../transactional-notifications/service.js";

type SenderConfig = {
  email?: string;
  sms?: string;
};

function phaseResult(attempted: number, scheduled: number): NotificationPhaseResult {
  return { attempted, scheduled };
}

function materializationFailure(error: unknown): {
  code: MessageFailureCode;
  retryable: boolean;
} {
  const code = error instanceof Error ? error.message : undefined;
  if (code === "MESSAGE_LEASE_LOST") {
    return { code: "MESSAGE_MATERIALIZATION_FAILED", retryable: true };
  }
  if (code === "MESSAGE_CONTACT_UNAVAILABLE" ||
      code === "MESSAGE_SMS_CONSENT_UNAVAILABLE" ||
      code === "MESSAGE_IDEMPOTENCY_CONFLICT" ||
      code === "MESSAGE_PAYLOAD_INVALID") {
    return { code: canonicalMessageFailureCode(code), retryable: false };
  }
  return { code: "MESSAGE_MATERIALIZATION_FAILED", retryable: true };
}

export class TransactionalNotificationOperationsAdapter
implements TransactionalNotificationOperations {
  private readonly repository: TransactionalNotificationRepository;
  private readonly worker: TransactionalNotificationWorkerService;

  constructor(
    private readonly pool: Pool,
    orderLookupBaseUrl: string,
    nodeEnv: string,
  ) {
    this.repository = new TransactionalNotificationRepository(
      pool,
      orderLookupBaseUrl,
      nodeEnv,
    );
    this.worker = new TransactionalNotificationWorkerService(this.repository);
  }

  async list(query: Parameters<TransactionalNotificationOperations["list"]>[0]) {
    return { notifications: await this.repository.list(query) };
  }

  listForOrder(orderId: string) {
    return this.repository.listByOrder(orderId);
  }

  async reconcileLifecycle(limit: number) {
    const scheduled = await this.worker.reconcileLifecycle(limit);
    return phaseResult(scheduled, scheduled);
  }

  async promoteRefundEffect(operationId: string) {
    const effect = await this.pool.query<{ id: string }>(
      `select id from refund_effects
       where refund_operation_id = $1::uuid
         and effect_type = 'customer_notification'
       limit 1`,
      [operationId],
    );
    if (!effect.rows[0]) return false;
    return Boolean(await this.repository.promoteRefundEffect(effect.rows[0].id));
  }

  async promoteRefundEffects(limit: number) {
    const scheduled = await this.worker.promoteRefundEffects(limit);
    return phaseResult(scheduled, scheduled);
  }

  async materializeIntents(
    limit: number,
    leaseOwner: string,
    senders: SenderConfig,
  ) {
    const intents = await this.worker.claimMaterializationIntents(
      leaseOwner,
      limit,
    );
    let failed = 0;
    let queued = 0;
    let retrying = 0;

    for (const intent of intents) {
      const fromAddress = intent.recipientChannel
        ? senders[intent.recipientChannel]
        : undefined;
      if (!fromAddress) {
        await this.repository.failMaterialization({
          failureCode: intent.recipientFailureCode ?? "MESSAGE_CHANNEL_UNAVAILABLE",
          intentId: intent.id,
          leaseOwner: intent.leaseOwner,
          retryable: false
        });
        failed += 1;
        continue;
      }
      try {
        const messageId = await this.worker.materializeClaimedIntent({
          fromAddress,
          intent
        });
        if (messageId) queued += 1;
        else failed += 1;
      } catch (error) {
        const failure = materializationFailure(error);
        await this.repository.failMaterialization({
          failureCode: failure.code,
          intentId: intent.id,
          leaseOwner: intent.leaseOwner,
          retryable: failure.retryable
        });
        if (failure.retryable) retrying += 1;
        else failed += 1;
      }
    }

    return { attempted: intents.length, failed, queued, retrying };
  }
}
