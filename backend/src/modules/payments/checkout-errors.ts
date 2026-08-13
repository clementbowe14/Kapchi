import type { CheckoutReviewIssue } from "./checkout-types.js";

export class CheckoutCartNotFoundError extends Error {
  constructor() {
    super("Cart not found.");
    this.name = "CheckoutCartNotFoundError";
  }
}

export class CheckoutNeedsReviewError extends Error {
  readonly issues: CheckoutReviewIssue[];

  constructor(message: string, issues: CheckoutReviewIssue[] = []) {
    super(message);
    this.name = "CheckoutNeedsReviewError";
    this.issues = issues;
  }
}

export class CheckoutProviderError extends Error {
  constructor() {
    super("Unable to start checkout. Please try again.");
    this.name = "CheckoutProviderError";
  }
}

export class CheckoutCatalogUnavailableError extends Error {
  readonly code = "CHECKOUT_CATALOG_UNAVAILABLE";

  constructor() {
    super(
      "Checkout is unavailable for one or more items. Please contact Kapchi support.",
    );
    this.name = "CheckoutCatalogUnavailableError";
  }
}

export class CheckoutAlreadyCompleteError extends Error {
  readonly checkoutSessionId: string;
  readonly orderId: string;
  readonly publicOrderNumber: string;

  constructor(recovery: {
    checkoutSessionId: string;
    orderId: string;
    publicOrderNumber: string;
  }) {
    super("This checkout has already completed.");
    this.name = "CheckoutAlreadyCompleteError";
    this.checkoutSessionId = recovery.checkoutSessionId;
    this.orderId = recovery.orderId;
    this.publicOrderNumber = recovery.publicOrderNumber;
  }
}
