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

export const MESSAGE_FAILURE_CODES = [
  "MESSAGE_CHANNEL_UNAVAILABLE",
  "MESSAGE_CONTACT_UNAVAILABLE",
  "MESSAGE_IDEMPOTENCY_CONFLICT",
  "MESSAGE_ATTEMPTS_EXHAUSTED",
  "MESSAGE_MATERIALIZATION_FAILED",
  "MESSAGE_MATERIALIZATION_EXHAUSTED",
  "MESSAGE_PAYLOAD_INVALID",
  "MESSAGE_PROVIDER_FAILED",
  "MESSAGE_PROVIDER_INVALID_RESPONSE",
  "MESSAGE_PROVIDER_NOT_CONFIGURED",
  "MESSAGE_PROVIDER_RATE_LIMITED",
  "MESSAGE_PROVIDER_REJECTED",
  "MESSAGE_PROVIDER_TIMEOUT",
  "MESSAGE_PROVIDER_UNAVAILABLE",
  "MESSAGE_RECIPIENT_REJECTED",
  "MESSAGE_RENDER_FAILED",
  "MESSAGE_SMS_CONSENT_UNAVAILABLE"
] as const;

export type MessageFailureCode = (typeof MESSAGE_FAILURE_CODES)[number];

const knownFailureCodes = new Set<string>(MESSAGE_FAILURE_CODES);

const providerFailureAliases: Readonly<Record<string, MessageFailureCode>> = {
  GATEWAY_TIMEOUT: "MESSAGE_PROVIDER_TIMEOUT",
  RECIPIENT_REJECTED: "MESSAGE_RECIPIENT_REJECTED",
  RATE_LIMITED: "MESSAGE_PROVIDER_RATE_LIMITED",
  TIMEOUT: "MESSAGE_PROVIDER_TIMEOUT"
};

export function canonicalMessageFailureCode(value: unknown): MessageFailureCode {
  if (typeof value !== "string") return "MESSAGE_PROVIDER_FAILED";
  const normalized = value.trim().toUpperCase();
  if (knownFailureCodes.has(normalized)) return normalized as MessageFailureCode;
  if (providerFailureAliases[normalized]) return providerFailureAliases[normalized];
  if (/^MESSAGE_PROVIDER_HTTP_408$/.test(normalized)) return "MESSAGE_PROVIDER_TIMEOUT";
  if (/^MESSAGE_PROVIDER_HTTP_429$/.test(normalized)) return "MESSAGE_PROVIDER_RATE_LIMITED";
  if (/^MESSAGE_PROVIDER_HTTP_5\d\d$/.test(normalized)) return "MESSAGE_PROVIDER_UNAVAILABLE";
  if (/^MESSAGE_PROVIDER_HTTP_4\d\d$/.test(normalized)) return "MESSAGE_PROVIDER_REJECTED";
  return "MESSAGE_PROVIDER_FAILED";
}
