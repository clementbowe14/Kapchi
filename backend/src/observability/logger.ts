const REDACTION_CENSOR = "[REDACTED]";

const sensitiveFields = [
  "authorization",
  "cookie",
  "setCookie",
  "stripeSignature",
  "secret",
  "secretKey",
  "stripeSecretKey",
  "webhookSecret",
  "clientSecret",
  "client_secret",
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "paymentMethod",
  "payment_method",
  "card",
  "customerEmail",
  "customerPhone",
  "email",
  "phone",
  "body",
  "rawBody",
  "payload",
  "webhookPayload"
] as const;

const nestedSensitivePaths = sensitiveFields.flatMap((field) => [
  field,
  `*.${field}`,
  `*.*.${field}`,
  `*.*.*.${field}`,
  `*.*.*.*.${field}`
]);

export const loggerRedactionPaths = Object.freeze([
  ...nestedSensitivePaths,
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['stripe-signature']",
  "request.headers.authorization",
  "request.headers.cookie",
  "request.headers['stripe-signature']",
  "res.headers['set-cookie']",
  "response.headers['set-cookie']",
  "headers.authorization",
  "headers.cookie",
  "headers['set-cookie']",
  "headers['stripe-signature']"
]);

export function createLoggerOptions(level: string) {
  return {
    level,
    redact: {
      censor: REDACTION_CENSOR,
      paths: [...loggerRedactionPaths]
    }
  };
}
