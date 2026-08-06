# Backend Observability

The backend emits JSON logs for every request and detailed lifecycle events for
checkout. Logs are designed to support production troubleshooting without
including credentials, customer contact data, or payment payloads.

## Request IDs

The server chooses one request ID for the complete request lifecycle:

1. A valid `x-request-id` is preserved.
2. Otherwise, a valid `x-correlation-id` is preserved.
3. Otherwise, the server generates a UUID.

Accepted inbound IDs are 1-128 characters and contain only letters, numbers,
`.`, `_`, `:`, `/`, or `-`. The first character must be alphanumeric. The
selected value is returned as `x-request-id` on every response and is included
in request and request-scoped service logs as `requestId`.

## HTTP Events

`http.request.completed` is emitted after every response with:

- `requestId`
- `method`
- `route`, using the Fastify route pattern when available
- `url`, without query parameters
- `statusCode`
- `durationMs`

`http.request.failed` is also emitted when a handler throws or a handled request
returns a 5xx response. It has the same fields plus `errorType` and, when safe,
`errorCode` for thrown errors. Error messages and stacks are intentionally
omitted.

## Checkout Events

Checkout logs use the following event names:

| Event | Meaning |
| --- | --- |
| `checkout.preparation.started` | Durable cart/order preparation began. |
| `checkout.preparation.succeeded` | Preparation produced an order and provider line items. |
| `checkout.preparation.failed` | Preparation failed before contacting Stripe. |
| `checkout.provider.requested` | A Stripe Checkout Session create or retrieve call began. |
| `checkout.provider.succeeded` | Stripe returned a Checkout Session. |
| `checkout.provider.failed` | Stripe create or retrieve failed. |
| `checkout.provider.session_reused` | An existing open Checkout Session was reused. |
| `checkout.session.terminal` | A complete, expired, or unusable session was handled. |
| `checkout.persistence.failed` | A checkout repository operation failed. |
| `checkout.succeeded` | The provider session was persisted and returned to the caller. |

Depending on the event, safe fields include `orderId`, `providerSessionId`,
`providerOperation`, `operation`, `disposition`, `lineItemCount`,
`existingProviderSession`, `errorType`, and `errorCode`. Checkout events use the
request logger, so they carry the HTTP `requestId` without passing HTTP objects
into the service.

## Redaction

Logger redaction covers authorization headers, cookies, Stripe signatures,
secret and token fields, passwords, raw bodies and payloads, customer email and
phone fields, client secrets, payment methods, and card fields. Remote provider
and infrastructure errors are logged only as an error type and a constrained
error code.

Do not add raw request bodies, webhook payloads, customer contact details, auth
tokens, provider error objects, or payment details to new event fields. Add new
structured identifiers or bounded state fields instead.

## Troubleshooting

1. Start with `http.request.failed` or a non-success
   `http.request.completed` event.
2. Search all logs for its `requestId` to reconstruct the request and checkout
   lifecycle.
3. For `checkout.provider.failed`, use `providerOperation`, `orderId`, and the
   Stripe Dashboard request logs. Do not add the Stripe error body to app logs.
4. For `checkout.persistence.failed`, use `operation`, `orderId`, and database
   health metrics or database logs.
5. For terminal sessions, inspect `disposition` and `providerSessionId`, then
   confirm durable order state before retrying.

The observer is intentionally vendor-neutral. A telemetry exporter can be
added later behind the observer interface without changing checkout behavior.
