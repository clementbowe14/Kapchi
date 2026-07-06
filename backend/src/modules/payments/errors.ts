export class CheckoutValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutValidationError";
  }
}

export class CheckoutOrderNotFoundError extends Error {
  constructor() {
    super("Order not found.");
    this.name = "CheckoutOrderNotFoundError";
  }
}

export class CheckoutOrderStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutOrderStateError";
  }
}

export class CheckoutProviderError extends Error {
  constructor(message = "Unable to create checkout session.") {
    super(message);
    this.name = "CheckoutProviderError";
  }
}
