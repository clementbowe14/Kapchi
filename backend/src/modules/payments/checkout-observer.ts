import type { FastifyBaseLogger } from "fastify";

export type CheckoutEventName =
  | "checkout.preparation.started"
  | "checkout.preparation.succeeded"
  | "checkout.preparation.failed"
  | "checkout.provider.requested"
  | "checkout.provider.succeeded"
  | "checkout.provider.failed"
  | "checkout.provider.session_reused"
  | "checkout.session.terminal"
  | "checkout.persistence.failed"
  | "checkout.succeeded";

export type CheckoutEventFields = {
  disposition?: "complete" | "expired" | "reusable" | "unusable";
  errorCode?: string;
  errorType?: string;
  existingProviderSession?: boolean;
  lineItemCount?: number;
  operation?: "finalize" | "mark_provider_failure" | "prepare" | "retire";
  orderId?: string;
  providerOperation?: "create" | "retrieve";
  providerSessionId?: string;
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
