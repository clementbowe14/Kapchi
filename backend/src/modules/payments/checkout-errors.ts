export class CheckoutCartNotFoundError extends Error {
  constructor() {
    super("Cart not found.");
    this.name = "CheckoutCartNotFoundError";
  }
}

export class CheckoutNeedsReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutNeedsReviewError";
  }
}

export class CheckoutProviderError extends Error {
  constructor() {
    super("Unable to start checkout. Please try again.");
    this.name = "CheckoutProviderError";
  }
}

export class CheckoutAlreadyCompleteError extends Error {
  constructor() {
    super("This checkout has already completed.");
    this.name = "CheckoutAlreadyCompleteError";
  }
}
