export class CartNotFoundError extends Error {
  constructor(message = "Cart not found.") {
    super(message);
    this.name = "CartNotFoundError";
  }
}

export class CartItemNotFoundError extends Error {
  constructor() {
    super("Cart item not found.");
    this.name = "CartItemNotFoundError";
  }
}

export class CartValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartValidationError";
  }
}

export class InvalidProductionPriorityError extends CartValidationError {
  constructor() {
    super("The selected production priority is unavailable.");
    this.name = "InvalidProductionPriorityError";
  }
}

export class CartConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartConflictError";
  }
}

export class CartIdempotencyConflictError extends CartConflictError {
  constructor() {
    super("This idempotency key was already used for a different cart item.");
    this.name = "CartIdempotencyConflictError";
  }
}
