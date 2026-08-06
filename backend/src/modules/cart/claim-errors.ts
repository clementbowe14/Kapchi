export class CartClaimConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartClaimConflictError";
  }
}

export class CartClaimForbiddenError extends Error {
  constructor() {
    super("This account is not available for cart claims.");
    this.name = "CartClaimForbiddenError";
  }
}
