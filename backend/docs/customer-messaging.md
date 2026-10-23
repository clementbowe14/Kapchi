# Customer messaging contract

Issue #12 adds order-linked admin messaging without coupling customer delivery
to financial or fulfillment state changes. PostgreSQL is authoritative for the
conversation, message, delivery job, inbound receipt, and audit history.

## Conversation state

Each order has at most one conversation with a stable
`kapchi-order:<order UUID>` thread key.

- A verified customer reply sets `awaiting_admin`, marks the conversation
  unread, and reopens a resolved conversation.
- An admin reply sets `awaiting_customer` and clears the admin unread flag.
- An internal note does not change who is awaiting a response and is never
  placed in a delivery job.
- Resolving, reopening, and marking read require the current conversation
  version. A stale version returns `CONVERSATION_VERSION_CONFLICT`.
- Delivery failure is recorded on the message and does not resolve or reopen a
  conversation by itself.

Inbox pagination is stable by `last_message_at` and conversation ID. Cursors
are opaque. Conversation responses expose `email`, `sms`, and `attachments`
capabilities; attachments remain `false` until private asset scanning and
provider delivery support are available.

## Admin API

All `/admin` routes use the shared exact-store-admin capability boundary.

- `GET /admin/messages/conversations` requires `orders:read` and accepts
  `status`, `adminUnread`, `limit`, and `cursor`.
- `GET /admin/messages/conversations/:orderId` requires `orders:read`.
- `POST /admin/messages/orders/:orderId/replies` requires `messages:write` and
  an `Idempotency-Key`. The body contains `channel`, `body`, and optional
  `subject`.
- `POST /admin/messages/orders/:orderId/notes` requires
  `order-notes:write` and an `Idempotency-Key`.
- `PATCH /admin/messages/conversations/:orderId` requires `messages:write`
  and accepts `read`, `resolve`, or `reopen` with `expectedVersion`.

The server resolves the actor from the verified Clerk subject. Client actor,
recipient, ownership, provider, and delivery-status fields are ignored. Reply
addresses come from the order/customer contact snapshot; an unavailable
channel returns an actionable conflict instead of simulating success.

## Contact and consent

Email and SMS are transactional order-service messages only. A checkout
preference of `phone` or `sms` maps to the SMS channel; it does not grant
marketing consent. `customer_contacts.accepts_marketing` is not consulted for
transactional replies and must not be reused to send campaigns. A selected
channel must have an address on the order's resolved contact record.

## Outbound gateway and retries

Configure a provider adapter or internal gateway with:

```text
MESSAGE_DELIVERY_URL=https://messaging-gateway.example.test/v1/messages
MESSAGE_DELIVERY_TOKEN=replace_me_delivery_token
MESSAGE_FROM_EMAIL=support@example.test
MESSAGE_FROM_SMS=+15555550100
```

The gateway receives a bearer token, an `Idempotency-Key`, and a provider-
neutral JSON body containing channel, recipient, sender, subject, body, and
thread key. It returns `{ "provider": "...", "messageId": "..." }`.

Run `npm run messages:dispatch` from a scheduler. Jobs use leases,
`FOR UPDATE SKIP LOCKED`, bounded exponential retry, and a durable idempotency
key. HTTP 408, 429, and 5xx responses retry; configuration, validation, and
other 4xx failures are terminal. Logs include IDs, channel, attempt count, and
safe error codes, never addresses, message text, provider bodies, or tokens.

## Inbound webhooks

Providers post normalized events to
`POST /messaging/webhooks/:provider`. Configure `MESSAGE_WEBHOOK_SECRET` and
send `x-kapchi-message-signature`, a lowercase hex HMAC-SHA256 over the
canonical event object produced by `signMessagingWebhook`. Events include an
epoch-seconds timestamp and are rejected outside a five-minute window.

Inbound messages require the stable thread key and a sender matching the
order's email or normalized phone snapshot. Provider event IDs are deduplicated
with a payload hash; reusing an ID for different content is a conflict. Forged,
ambiguous, and unmatched events are rejected without creating a message.

## Refund notifications

A requested `customer_notification` refund effect is pending until the refund
ledger reports success. The messaging worker then creates one idempotent system
message and delivery job. Delivery success/failure updates only the effect and
message records. It never changes, retries, or rolls back the Stripe refund.
