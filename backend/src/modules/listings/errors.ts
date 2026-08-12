export class ListingNotFoundError extends Error {
  constructor() {
    super("The requested graduation stole listing was not found.");
    this.name = "ListingNotFoundError";
  }
}

export class ListingsUnavailableError extends Error {
  constructor() {
    super("The graduation stole catalog is temporarily unavailable.");
    this.name = "ListingsUnavailableError";
  }
}
