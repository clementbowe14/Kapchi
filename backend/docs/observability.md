# Backend Observability

The backend emits JSON logs for every request and detailed lifecycle events for
cart and checkout workflows. Logs are designed to support production
troubleshooting without including credentials, customer contact data,
customization content, or payment payloads.

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

## Cart Events

Cart route events use the request logger and therefore include the HTTP
`requestId`. The cart observer emits one completion event for a successful
operation or one `cart.operation.failed` event when the cart route handles or
throws an error.

| Event | Operation | Meaning |
| --- | --- | --- |
| `cart.read.completed` | `read` or `summary` | A full cart or lightweight count summary was read. |
| `cart.item.added` | `add` | An idempotent add-item request completed. |
| `cart.item.updated` | `update` | A cart item was updated. |
| `cart.item.removed` | `remove` | A cart item was removed. |
| `cart.claim.completed` | `claim` | A guest cart was merged into an authenticated cart. |
| `cart.operation.failed` | Any cart operation | A handled 4xx or unexpected failure occurred. |

Every cart event includes `actorType`, `durationMs`, and `operation`. Successful
events include the available bounded state fields: `cartId`, `cartItemId`,
`revision`, `lineItemCount`, `totalQuantity`, and `subtotalCents`. Failure events
include `statusCode`, `errorType`, and a constrained `errorCode` when available;
they use warning level for 4xx responses and error level for 5xx responses.

`lineItemCount` is the number of distinct cart rows. `totalQuantity` is the sum
of the rows' quantities and is the value a navigation badge should display.
`revision` changes after a successful cart mutation and can identify stale or
out-of-order client responses. `GET /cart/summary` returns these count fields
without loading the full cart. A guest without a valid cart context receives a
zero summary and the read does not create a cart or set a guest cookie.

Retry-safe callers of `POST /cart/items` send a bounded `Idempotency-Key`
header. Retrying the same payload with the same key returns the original
result; reusing the key for a different payload returns
`409 CART_IDEMPOTENCY_CONFLICT`. During independent client/backend rollouts, a
legacy request without the header receives a server-generated one-request key,
so it remains compatible but is not safe to replay. The key itself is never
logged.

## Redaction

Logger redaction covers authorization headers, cookies, Stripe signatures,
secret and token fields, passwords, raw bodies and payloads, customer email and
phone fields, client secrets, payment methods, and card fields. Cart event
payloads are allowlisted separately and never include guest session values or
hashes, auth subjects, customer data, customization text, asset or file
metadata, request bodies, idempotency keys, or raw errors. Remote provider and
infrastructure errors are logged only as an error type and a constrained error
code.

Do not add raw request bodies, webhook payloads, customer contact details, auth
tokens, provider error objects, or payment details to new event fields. Add new
structured identifiers or bounded state fields instead.

## Troubleshooting

1. Start with `http.request.failed` or a non-success
   `http.request.completed` event.
2. Search all logs for its `requestId` to reconstruct the request and workflow
   lifecycle.
3. For a cart count mismatch, compare `revision`, `lineItemCount`, and
   `totalQuantity` across the latest `cart.*` events. A lower revision arriving
   after a higher revision points to an out-of-order client response; a badge
   using `lineItemCount` instead of `totalQuantity` points to a client contract
   mismatch.
4. For `CART_IDEMPOTENCY_CONFLICT`, verify that the client creates one key per
   logical add action and preserves it only while retrying that same payload.
5. For repeated cart 4xx responses, filter `cart.operation.failed` by
   `operation`, `errorCode`, and `actorType`. Use `cartId` or `cartItemId` when
   present, without adding sensitive request content to logs.
6. For `checkout.provider.failed`, use `providerOperation`, `orderId`, and the
   Stripe Dashboard request logs. Do not add the Stripe error body to app logs.
7. For `checkout.persistence.failed`, use `operation`, `orderId`, and database
   health metrics or database logs.
8. For terminal sessions, inspect `disposition` and `providerSessionId`, then
   confirm durable order state before retrying.

The observer is intentionally vendor-neutral. A telemetry exporter can be
added later behind the observer interface without changing checkout behavior.
