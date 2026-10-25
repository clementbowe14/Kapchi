import { randomUUID } from "node:crypto";
import { RefundError, RefundProviderError } from "./errors.js";
import { refundRequestFingerprint } from "./fingerprint.js";
import type { RefundProvider } from "./provider.js";
import type { RefundRepository, StoredRefundOperation } from "./repository.js";
import type { RefundActor, RefundRequest } from "./types.js";

export type RefundRepositoryPort = Pick<
  RefundRepository,
  | "applyProviderResult"
  | "applyReconciliation"
  | "claimDispatch"
  | "findByClientKey"
  | "getOperation"
  | "getOrderPaymentIntent"
  | "claimRecoveryCandidates"
  | "markReconciliationFailure"
  | "markProviderError"
  | "reserve"
  | "resolveActor"
  | "summary"
>;

export type RefundObserver = {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

export type RefundNotificationScheduler = {
  scheduleRefundNotification(operationId: string): Promise<boolean>;
};

const noopObserver: RefundObserver = {
  error() {},
  info() {},
  warn() {}
};

export class RefundService {
  constructor(
    private readonly repository: RefundRepositoryPort,
    private readonly provider: RefundProvider,
    private readonly observer: RefundObserver = noopObserver,
    private readonly notificationScheduler?: RefundNotificationScheduler,
  ) {}

  resolveActor(authSubject: string) {
    return this.repository.resolveActor(authSubject);
  }

  async create(
    orderId: string,
    actor: RefundActor,
    request: RefundRequest,
    clientIdempotencyKey: string,
  ) {
    const fingerprint = refundRequestFingerprint(orderId, actor, request);
    const existing = await this.repository.findByClientKey(clientIdempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new RefundError(
          "IDEMPOTENCY_CONFLICT",
          "This idempotency key was already used for a different refund request.",
          409,
        );
      }
      if (existing.status !== "pending") {
        await this.scheduleNotification(existing);
        return { operation: existing, replayed: true };
      }
      const recovered = await this.recover(existing);
      return { operation: recovered, replayed: true };
    }

    const payment = await this.repository.getOrderPaymentIntent(orderId);
    const snapshot = await this.reconcile(orderId, payment.paymentIntentId);
    if (snapshot.currency !== request.currency) {
      throw new RefundError(
        "CURRENCY_MISMATCH",
        "Refund currency does not match the captured payment.",
        409,
      );
    }
    const reserved = await this.repository.reserve(
      orderId,
      actor,
      request,
      clientIdempotencyKey,
      fingerprint,
    );
    this.observer.info("refund.reserved", {
      operationId: reserved.id,
      orderId,
      resultCode: "RESERVED"
    });
    return { operation: await this.dispatch(reserved), replayed: false };
  }

  async getSummary(orderId: string) {
    const payment = await this.repository.getOrderPaymentIntent(orderId);
    await this.reconcile(orderId, payment.paymentIntentId);
    return this.repository.summary(orderId);
  }

  async getOperation(id: string) {
    const current = await this.repository.getOperation(id);
    if (!current) {
      throw new RefundError("REFUND_NOT_FOUND", "Refund operation not found.", 404);
    }
    if (current.status === "pending" && current.pendingReason !== "provider_conflict") {
      return this.recover(current);
    }
    await this.scheduleNotification(current);
    return current;
  }

  async runRecovery(limit = 25) {
    const leaseOwner = randomUUID();
    const candidates = await this.repository.claimRecoveryCandidates(limit, leaseOwner);
    const outcomes = [];
    for (const candidate of candidates) {
      try {
        outcomes.push(await this.recover(candidate));
      } catch (error) {
        const resultCode = error instanceof RefundError
          ? error.code
          : error instanceof RefundProviderError
            ? error.code
            : "UNEXPECTED_ERROR";
        await this.repository.markReconciliationFailure(
          candidate.id,
          leaseOwner,
          resultCode,
        );
        this.observer.error("refund.reconciliation.failed", {
          operationId: candidate.id,
          orderId: candidate.orderId,
          resultCode
        });
      }
    }
    return { attempted: candidates.length, completed: outcomes.length };
  }

  private async recover(current: StoredRefundOperation) {
    if (current.providerRefundId) {
      try {
        const refund = await this.provider.retrieveRefund(current.providerRefundId);
        const updated = await this.repository.applyProviderResult(current.id, refund);
        await this.scheduleNotification(updated);
        return updated;
      } catch (error) {
        if (error instanceof RefundProviderError) {
          await this.repository.markProviderError(current.id, error.code, true);
          return (await this.repository.getOperation(current.id))!;
        }
        throw error;
      }
    }

    const snapshot = await this.reconcile(current.orderId, current.paymentIntentId);
    const refreshed = await this.repository.getOperation(current.id);
    if (!refreshed || refreshed.status !== "pending") return refreshed ?? current;
    if (refreshed.pendingReason !== "reserved" || refreshed.manualReviewRequired) {
      return refreshed;
    }
    const ageMs = Date.now() - Date.parse(refreshed.createdAt);
    if (refreshed.dispatchEverClaimed && ageMs >= 23 * 60 * 60 * 1000) {
      return refreshed;
    }
    if (snapshot.refunds.some((refund) => refund.metadata.operationId === refreshed.id)) {
      return (await this.repository.getOperation(refreshed.id)) ?? refreshed;
    }
    return this.dispatch(refreshed);
  }

  private async dispatch(operation: StoredRefundOperation) {
    const claimed = await this.repository.claimDispatch(operation.id, randomUUID());
    if (!claimed) {
      return (await this.repository.getOperation(operation.id)) ?? operation;
    }
    this.observer.info("refund.provider.requested", {
      operationId: claimed.id,
      orderId: claimed.orderId,
      resultCode: "REQUESTED"
    });
    try {
      const refund = await this.provider.createRefund({
        amountCents: claimed.amountCents,
        currency: claimed.currency,
        idempotencyKey: claimed.providerIdempotencyKey,
        livemode: claimed.livemode,
        operationId: claimed.id,
        orderId: claimed.orderId,
        paymentIntentId: claimed.paymentIntentId,
        reasonCode: claimed.reasonCode
      });
      const updated = await this.repository.applyProviderResult(claimed.id, refund);
      await this.scheduleNotification(updated);
      this.observer.info("refund.provider.completed", {
        operationId: claimed.id,
        orderId: claimed.orderId,
        resultCode: updated.status.toUpperCase()
      });
      return updated;
    } catch (error) {
      if (error instanceof RefundProviderError) {
        const updated = await this.repository.markProviderError(
          claimed.id,
          error.code,
          error.ambiguous,
        );
        this.observer[error.ambiguous ? "warn" : "error"]("refund.provider.failed", {
          operationId: claimed.id,
          orderId: claimed.orderId,
          resultCode: error.ambiguous ? "UNKNOWN_OUTCOME" : error.code
        });
        if (!error.ambiguous) {
          throw new RefundError(
            "REFUND_PROVIDER_FAILED",
            "Stripe rejected the refund request.",
            502,
            claimed.id,
          );
        }
        return updated ?? claimed;
      }
      throw error;
    }
  }

  private async reconcile(orderId: string, paymentIntentId: string) {
    try {
      const snapshot = await this.provider.reconcilePayment(paymentIntentId);
      await this.repository.applyReconciliation(orderId, snapshot);
      this.observer.info("refund.reconciliation.succeeded", {
        orderId,
        resultCode: "CURRENT"
      });
      return snapshot;
    } catch (error) {
      if (error instanceof RefundError) throw error;
      if (
        error instanceof RefundProviderError &&
        error.code === "PAYMENT_NOT_CAPTURED"
      ) {
        throw new RefundError(
          "REFUND_NOT_ALLOWED",
          "This order has no refundable captured payment.",
          409,
        );
      }
      const code = error instanceof RefundProviderError
        ? error.code
        : "REFUND_RECONCILIATION_UNAVAILABLE";
      this.observer.warn("refund.reconciliation.failed", { orderId, resultCode: code });
      throw new RefundError(
        "REFUND_RECONCILIATION_UNAVAILABLE",
        "Stripe refund reconciliation is temporarily unavailable.",
        503,
      );
    }
  }

  private async scheduleNotification(operation: StoredRefundOperation) {
    if (
      operation.status !== "succeeded" ||
      !operation.notificationRequested ||
      !this.notificationScheduler
    ) return;
    try {
      await this.notificationScheduler.scheduleRefundNotification(operation.id);
    } catch {
      this.observer.error("refund.notification.scheduling_failed", {
        operationId: operation.id,
        orderId: operation.orderId,
        resultCode: "MESSAGE_SCHEDULING_FAILED"
      });
    }
  }
}
