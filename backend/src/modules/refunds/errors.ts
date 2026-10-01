export class RefundError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly operationId?: string,
  ) {
    super(message);
    this.name = "RefundError";
  }
}

export class RefundProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly ambiguous: boolean,
  ) {
    super(message);
    this.name = "RefundProviderError";
  }
}

