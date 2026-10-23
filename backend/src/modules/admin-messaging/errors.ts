export class MessagingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "MessagingError";
  }
}

export class MessageProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super("Message delivery provider request failed.");
    this.name = "MessageProviderError";
  }
}
