export type LegacyPolicyCheckout = {
  orderId: string;
  stripeCheckoutSessionId: string;
};

export type LegacyPolicyProviderSession = {
  expiresAt: Date | null;
  id: string;
  paymentStatus: string;
  status: string | null;
};

export interface LegacyPolicyEnforcementProvider {
  expire(sessionId: string): Promise<void>;
  retrieve(sessionId: string): Promise<LegacyPolicyProviderSession>;
}

export interface LegacyPolicyEnforcementStore {
  listSessionBearingOrdersWithoutEvidence(): Promise<LegacyPolicyCheckout[]>;
  retireExpiredSession(
    orderId: string,
    session: { expiresAt: Date | null; sessionId: string },
  ): Promise<void>;
}

export type LegacyPolicyEnforcementResult = {
  discoveredCount: number;
  failedCount: number;
  remainingCount: number;
  resultCode: "EXPIRATION_INCOMPLETE" | "LEGACY_SESSIONS_REMAIN" | "READY";
  retiredCount: number;
};

type LegacyPolicyEnforcementOptions = {
  expire: boolean;
  provider?: LegacyPolicyEnforcementProvider;
  store: LegacyPolicyEnforcementStore;
};

function isPaid(session: LegacyPolicyProviderSession) {
  return (
    session.status === "complete" ||
    session.paymentStatus === "paid" ||
    session.paymentStatus === "no_payment_required"
  );
}

export async function enforceLegacyPolicySessions({
  expire,
  provider,
  store
}: LegacyPolicyEnforcementOptions): Promise<LegacyPolicyEnforcementResult> {
  const candidates = await store.listSessionBearingOrdersWithoutEvidence();
  if (!expire || candidates.length === 0) {
    return {
      discoveredCount: candidates.length,
      failedCount: 0,
      remainingCount: candidates.length,
      resultCode: candidates.length === 0 ? "READY" : "LEGACY_SESSIONS_REMAIN",
      retiredCount: 0
    };
  }
  if (!provider) {
    throw new Error("A checkout provider is required for expiration mode.");
  }

  let failedCount = 0;
  let retiredCount = 0;

  for (const candidate of candidates) {
    try {
      let session = await provider.retrieve(candidate.stripeCheckoutSessionId);
      if (session.id !== candidate.stripeCheckoutSessionId || isPaid(session)) {
        failedCount += 1;
        continue;
      }

      if (session.status === "open") {
        await provider.expire(candidate.stripeCheckoutSessionId);
        session = await provider.retrieve(candidate.stripeCheckoutSessionId);
      }

      if (
        session.id !== candidate.stripeCheckoutSessionId ||
        session.status !== "expired" ||
        isPaid(session)
      ) {
        failedCount += 1;
        continue;
      }

      await store.retireExpiredSession(candidate.orderId, {
        expiresAt: session.expiresAt,
        sessionId: candidate.stripeCheckoutSessionId
      });
      retiredCount += 1;
    } catch {
      failedCount += 1;
    }
  }

  const remaining = await store.listSessionBearingOrdersWithoutEvidence();
  return {
    discoveredCount: candidates.length,
    failedCount,
    remainingCount: remaining.length,
    resultCode:
      failedCount === 0 && remaining.length === 0
        ? "READY"
        : "EXPIRATION_INCOMPLETE",
    retiredCount
  };
}
