import { safeErrorDetails } from "../../observability/safe-error.js";
import {
  CheckoutAlreadyCompleteError,
  CheckoutProviderError
} from "./checkout-errors.js";
import type {
  CheckoutEventFields,
  CheckoutEventName,
  CheckoutObserver
} from "./checkout-observer.js";
import type {
  CheckoutProvider,
  CheckoutProviderSession
} from "./checkout-provider.js";
import type {
  CheckoutContact,
  CheckoutCartOwner,
  CheckoutResult,
  PreparedCheckout
} from "./checkout-types.js";

export interface CheckoutRepositoryPort {
  finalizeCheckout(
    orderId: string,
    session: {
      customerId: string | null;
      expiresAt: Date | null;
      sessionId: string;
    },
  ): Promise<void>;
  markProviderFailure(orderId: string): Promise<void>;
  prepareCheckout(
    context: CheckoutCartOwner,
    contact: CheckoutContact,
  ): Promise<PreparedCheckout>;
  retireTerminalCheckout(
    orderId: string,
    session: { expiresAt: Date | null; sessionId: string },
    reason: "provider_session_expired" | "provider_session_unusable",
  ): Promise<void>;
}

export type CheckoutRedirects = {
  cancelUrl: string;
  successUrl: string;
};

export interface Clock {
  now(): Date;
}

export type CheckoutServiceDependencies = {
  clock: Clock;
  observer: CheckoutObserver;
  provider: CheckoutProvider;
  redirects: CheckoutRedirects;
  repository: CheckoutRepositoryPort;
};

function sessionDisposition(session: CheckoutProviderSession, now: Date) {
  if (
    session.status === "complete" ||
    session.paymentStatus === "paid" ||
    session.paymentStatus === "no_payment_required"
  ) {
    return "complete" as const;
  }

  if (
    session.status === "expired" ||
    !session.expiresAt ||
    session.expiresAt.getTime() <= now.getTime()
  ) {
    return "expired" as const;
  }

  if (session.status === "open" && session.url) {
    return "reusable" as const;
  }

  return "unusable" as const;
}

export class CheckoutService {
  private readonly clock: Clock;
  private readonly observer: CheckoutObserver;
  private readonly provider: CheckoutProvider;
  private readonly redirects: CheckoutRedirects;
  private readonly repository: CheckoutRepositoryPort;

  constructor(dependencies: CheckoutServiceDependencies) {
    this.clock = dependencies.clock;
    this.observer = dependencies.observer;
    this.provider = dependencies.provider;
    this.redirects = dependencies.redirects;
    this.repository = dependencies.repository;
  }

  async startCheckout(
    context: CheckoutCartOwner,
    contact: CheckoutContact,
  ): Promise<CheckoutResult> {
    let prepared = await this.prepareCheckout(context, contact);
    let session = await this.requestProviderSession(prepared);
    let disposition = sessionDisposition(session, this.clock.now());

    if (prepared.existingStripeSessionId && disposition === "reusable") {
      this.observe("info", "checkout.provider.session_reused", {
        disposition,
        orderId: prepared.orderId,
        providerSessionId: session.id
      });
    }

    if (disposition === "complete") {
      if (!prepared.existingStripeSessionId) {
        await this.finalize(prepared.orderId, session);
      }
      this.observe("info", "checkout.session.terminal", {
        disposition,
        orderId: prepared.orderId,
        providerSessionId: session.id
      });
      throw new CheckoutAlreadyCompleteError();
    }

    if (disposition === "expired" || disposition === "unusable") {
      await this.retire(prepared.orderId, session, disposition);

      if (!prepared.existingStripeSessionId) {
        throw new CheckoutProviderError();
      }

      prepared = await this.prepareCheckout(context, contact);
      session = await this.requestProviderSession(prepared);
      disposition = sessionDisposition(session, this.clock.now());

      if (disposition === "complete") {
        await this.finalize(prepared.orderId, session);
        this.observe("info", "checkout.session.terminal", {
          disposition,
          orderId: prepared.orderId,
          providerSessionId: session.id
        });
        throw new CheckoutAlreadyCompleteError();
      }
      if (disposition !== "reusable") {
        await this.retire(prepared.orderId, session, disposition);
        throw new CheckoutProviderError();
      }
    }

    await this.finalize(prepared.orderId, session);
    this.observe("info", "checkout.succeeded", {
      orderId: prepared.orderId,
      providerSessionId: session.id
    });

    return {
      checkoutSessionId: session.id,
      orderId: prepared.orderId,
      paymentStatus: "checkout_started",
      url: session.url!
    };
  }

  private async prepareCheckout(
    context: CheckoutCartOwner,
    contact: CheckoutContact,
  ) {
    this.observe("info", "checkout.preparation.started");

    try {
      const prepared = await this.repository.prepareCheckout(context, contact);
      this.observe("info", "checkout.preparation.succeeded", {
        existingProviderSession: Boolean(prepared.existingStripeSessionId),
        lineItemCount: prepared.lines.length,
        orderId: prepared.orderId
      });
      return prepared;
    } catch (error) {
      this.observe("error", "checkout.preparation.failed", {
        ...safeErrorDetails(error),
        operation: "prepare"
      });
      throw error;
    }
  }

  private async requestProviderSession(prepared: PreparedCheckout) {
    const providerOperation = prepared.existingStripeSessionId
      ? "retrieve"
      : "create";
    const fields = {
      orderId: prepared.orderId,
      providerOperation
    } as const;
    this.observe("info", "checkout.provider.requested", fields);

    try {
      const session = prepared.existingStripeSessionId
        ? await this.provider.retrieveSession(prepared.existingStripeSessionId)
        : await this.provider.createSession(
            {
              cancelUrl: this.redirects.cancelUrl,
              customerEmail: prepared.customerEmail,
              lines: prepared.lines,
              orderId: prepared.orderId,
              successUrl: this.redirects.successUrl
            },
            `cart-checkout:${prepared.orderId}`,
          );

      this.observe("info", "checkout.provider.succeeded", {
        ...fields,
        providerSessionId: session.id
      });
      return session;
    } catch (error) {
      this.observe("error", "checkout.provider.failed", {
        ...fields,
        ...safeErrorDetails(error)
      });

      try {
        await this.repository.markProviderFailure(prepared.orderId);
      } catch (persistenceError) {
        this.observe("error", "checkout.persistence.failed", {
          ...safeErrorDetails(persistenceError),
          operation: "mark_provider_failure",
          orderId: prepared.orderId
        });
        throw persistenceError;
      }

      throw new CheckoutProviderError();
    }
  }

  private async retire(
    orderId: string,
    session: CheckoutProviderSession,
    disposition: "expired" | "unusable",
  ) {
    try {
      await this.repository.retireTerminalCheckout(
        orderId,
        {
          expiresAt: session.expiresAt,
          sessionId: session.id
        },
        disposition === "expired"
          ? "provider_session_expired"
          : "provider_session_unusable",
      );
    } catch (error) {
      this.observe("error", "checkout.persistence.failed", {
        ...safeErrorDetails(error),
        operation: "retire",
        orderId,
        providerSessionId: session.id
      });
      throw error;
    }

    this.observe("warn", "checkout.session.terminal", {
      disposition,
      orderId,
      providerSessionId: session.id
    });
  }

  private async finalize(orderId: string, session: CheckoutProviderSession) {
    try {
      await this.repository.finalizeCheckout(orderId, {
        customerId: session.customerId,
        expiresAt: session.expiresAt,
        sessionId: session.id
      });
    } catch (error) {
      this.observe("error", "checkout.persistence.failed", {
        ...safeErrorDetails(error),
        operation: "finalize",
        orderId,
        providerSessionId: session.id
      });
      throw error;
    }
  }

  private observe(
    level: "error" | "info" | "warn",
    event: CheckoutEventName,
    fields?: CheckoutEventFields,
  ) {
    try {
      this.observer[level](event, fields);
    } catch {
      // Diagnostics must never change checkout behavior.
    }
  }
}
