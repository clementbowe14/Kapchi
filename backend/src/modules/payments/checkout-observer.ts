import type { FastifyBaseLogger } from "fastify";

export type CheckoutEventName =
  | "checkout.contact.accepted"
  | "checkout.contact.rejected"
  | "checkout.preparation.started"
  | "checkout.preparation.succeeded"
  | "checkout.preparation.failed"
  | "checkout.provider.requested"
  | "checkout.provider.succeeded"
  | "checkout.provider.failed"
  | "checkout.provider.session_reused"
  | "checkout.session.terminal"
  | "checkout.persistence.failed"
  | "checkout.review.required"
  | "checkout.status.denied"
  | "checkout.status.read"
  | "checkout.succeeded"
  | "stripe.webhook.failed"
  | "stripe.webhook.ignored"
  | "stripe.webhook.processed"
  | "stripe.webhook.verified";

export type CheckoutEventFields = {
  authMode?: "authenticated" | "guest";
  disposition?: "complete" | "expired" | "reusable" | "unusable";
  errorCode?: string;
  errorType?: string;
  existingProviderSession?: boolean;
  lineItemCount?: number;
  operation?: "finalize" | "mark_provider_failure" | "prepare" | "retire";
  orderId?: string;
  providerOperation?: "create" | "retrieve";
  providerSessionId?: string;
  resultCode?: string;
  reviewIssueCount?: number;
  webhookEventId?: string;
  webhookEventType?: string;
  webhookOutcome?: "already_paid" | "terminal_state" | "unknown_order" | "updated";
};

export interface CheckoutObserver {
  error(event: CheckoutEventName, fields?: CheckoutEventFields): void;
  info(event: CheckoutEventName, fields?: CheckoutEventFields): void;
  warn(event: CheckoutEventName, fields?: CheckoutEventFields): void;
}

export function createCheckoutObserver(
  logger: Pick<FastifyBaseLogger, "error" | "info" | "warn">,
): CheckoutObserver {
  const write = (
    level: "error" | "info" | "warn",
    event: CheckoutEventName,
    fields: CheckoutEventFields = {},
  ) => {
    logger[level]({ event, ...fields }, "Checkout lifecycle event");
  };

  return {
    error: (event, fields) => write("error", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields)
  };
}
