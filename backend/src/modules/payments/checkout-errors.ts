import type { CheckoutReviewIssue } from "./checkout-types.js";
import type { PolicyBundle } from "../policies/policy-contract.js";

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

export class CheckoutPolicyAssertionRequiredError extends Error {
  readonly code = "POLICY_ASSERTION_REQUIRED";

  constructor() {
    super(
      "You must agree to the Terms of Sale and acknowledge the Returns and Personalized Goods Policy before checkout.",
    );
    this.name = "CheckoutPolicyAssertionRequiredError";
  }
}

export class CheckoutPolicyVersionStaleError extends Error {
  readonly code = "POLICY_VERSION_STALE";
  readonly currentPolicyBundle: PolicyBundle;
  readonly requestedBundleVersion: string;

  constructor(requestedBundleVersion: string, currentPolicyBundle: PolicyBundle) {
    super("The checkout policies changed. Review the current policies and try again.");
    this.name = "CheckoutPolicyVersionStaleError";
    this.requestedBundleVersion = requestedBundleVersion;
    this.currentPolicyBundle = currentPolicyBundle;
  }
}

export class CheckoutPolicyEvidenceMissingError extends Error {
  readonly code = "CHECKOUT_POLICY_EVIDENCE_REQUIRED";

  constructor() {
    super(
      "This checkout cannot continue because its policy record is unavailable. Please contact Kapchi support.",
    );
    this.name = "CheckoutPolicyEvidenceMissingError";
  }
}
