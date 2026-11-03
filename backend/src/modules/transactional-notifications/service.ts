import { renderNotification } from "./renderers.js";
import type { TransactionalNotificationWorkerRepository } from "./repository.js";

export class TransactionalNotificationWorkerService {
  constructor(private readonly repository: TransactionalNotificationWorkerRepository) {}

  reconcileLifecycle(limit = 50) {
    return this.repository.reconcileLifecycle(limit);
  }

  promoteRefundEffects(limit = 50) {
    return this.repository.promoteRefundEffects(limit);
  }

  claimMaterializationIntents(workerId: string, limit = 50) {
    return this.repository.claimMaterializationIntents(workerId, limit);
  }

  async materializeClaimedIntent(input: {
    fromAddress: string;
    intent: Awaited<ReturnType<TransactionalNotificationWorkerRepository["claimMaterializationIntents"]>>[number];
  }) {
    if (input.intent.recipientFailureCode || !input.intent.recipientChannel) {
      await this.repository.failMaterialization({
        failureCode: input.intent.recipientFailureCode ?? "MESSAGE_CONTACT_UNAVAILABLE",
        intentId: input.intent.id,
        leaseOwner: input.intent.leaseOwner,
        retryable: false
      });
      return null;
    }
    const rendered = renderNotification(
      input.intent.kind,
      input.intent.recipientChannel,
      input.intent.payload,
    );
    return this.repository.materializeIntent({
      fromAddress: input.fromAddress,
      intentId: input.intent.id,
      leaseOwner: input.intent.leaseOwner,
      rendered
    });
  }
}
