# Issue 116: Transactional Order Notifications

Status: Approved for implementation

## Objective

Send durable, customer-safe order confirmations and fulfillment updates without coupling payment, refund, or fulfillment transactions to an external messaging provider. Guest and authenticated orders use the contact details captured at checkout. Delivery failures remain visible to administrators and never undo a completed business transition.

## Scope

This work covers these notification kinds:

1. `order.confirmed` after authoritative payment success.
2. `order.cancelled` after an order enters the cancelled state.
3. `refund.completed` after a refund operation succeeds.
4. `order.shipped` after shipment confirmation.
5. `order.delivered` after delivery is recorded.

The current application has direct writers for payment success, refund completion, and shipment confirmation. It does not yet expose a paid-order cancellation mutation or a delivery/carrier-webhook mutation. To cover those lifecycle states without inventing unrelated public commands, the worker adds a bounded reconciliation phase that creates missing intents from authoritative paid-order and shipment state. A cancelled order qualifies only when `paid_at is not null` and `payment_status in ('paid', 'partially_refunded', 'refunded')`; an unpaid checkout retired after catalog/provider failure does not. A shipment qualifies only when `status in ('delivered', 'completed')`, `delivered_at is not null`, and its order satisfies the same authoritative-paid predicate. Future cancellation and delivery writers must also call the shared intent writer in their transaction for immediate scheduling; reconciliation remains the recovery backstop.

No promotional messaging, new customer-authentication flow, provider selection UI, or message-template editor is included.

## Design Principles

- PostgreSQL remains the durable source of truth. No provider call occurs in a Stripe webhook, refund, or fulfillment transaction.
- Payment and shipment transitions commit their notification intents atomically. Refund completion commits its existing `customer_notification` effect atomically and promotes that durable effect into an intent later. Cancellation and delivery reconciliation reads only already-committed authoritative state. Provider, contact, configuration, and rendering failures are handled later and cannot roll back business state.
- A single semantic event has one stable idempotency key across webhook replays, worker retries, and process restarts.
- Transactional notifications use only `orders.customer_email`, `orders.customer_phone`, and `orders.preferred_contact_method`. They must not reuse messaging conversation queries that prefer mutable customer/contact records. The intent snapshots the selected normalized recipient during creation, so later profile or contact edits cannot redirect delivery.
- Logs and operational events contain identifiers, state, channel, attempt count, and bounded error codes only. They never contain contact addresses, message bodies, item customization text, tracking URLs, or lookup URLs.
- The existing `order_messages` and `message_delivery_jobs` contract from issue #12 remains the only provider-delivery queue.

## Persistence Model

Add `transactional_notification_intents` as the durable bridge between an authoritative domain event and the existing message outbox.

Each intent stores:

- `id`, `order_id`, and `kind`.
- A globally unique `idempotency_key` derived from the semantic source event.
- `source_type` and `source_id` for correlation without provider data.
- A versioned, customer-safe JSON payload snapshot needed to render the message.
- Lifecycle state: `pending`, `leased`, `retryable`, `queued`, `succeeded`, or `failed`.
- Materialization attempt count, maximum materialization attempts, next-attempt timestamp, lease owner/expiry, and a bounded failure code. Provider delivery attempts remain separately owned by `message_delivery_jobs`.
- Optional `order_message_id` after materialization, plus the normalized recipient channel and address selected from the order snapshot. Recipient fields are private delivery data and are never returned by notification-status APIs.
- Created, updated, queued, succeeded, and failed timestamps.

The payload snapshot contains only fields safe to send to the customer:

- Public order number.
- Currency and monetary amounts in integer minor units.
- A bounded item summary containing product title and quantity only.
- Carrier, tracking number, and server-derived tracking URL for shipment messages when available.
- Refund amount for refund completion.
- A fixed order-lookup URL containing no email, phone, public order number, user ID, or authentication secret.

The database enforces one intent per idempotency key and one materialized message per intent. Replayed inserts fetch and compare the existing order, kind, source, payload hash, and recipient snapshot. An exact match is recovered success; a mismatch is a terminal `MESSAGE_IDEMPOTENCY_CONFLICT` and never overwrites the original record.

State rules are enforced by checks: only `leased` rows have lease fields; only `queued`, `succeeded`, or delivery-terminal `failed` rows have `order_message_id`; only `succeeded` rows have `succeeded_at`; only `failed` rows have `failed_at`; and terminal states cannot be reclaimed. Legal transitions are `pending|retryable -> leased`, expired `leased -> leased` with an atomic lease-owner replacement and incremented materialization attempt, `leased -> retryable|queued|failed`, and `queued -> succeeded|failed`. Completion/failure updates compare intent ID, state, and lease owner or linked message ID.

## Stable Idempotency Keys

- Confirmation: `transactional:order-confirmed:<order-id>`.
- Cancellation: `transactional:order-cancelled:<order-id>` because cancellation is terminal and paid-order-only.
- Refund: `transactional:refund-completed:<refund-operation-id>`.
- Shipment: `transactional:order-shipped:<shipment-id>`.
- Delivery: `transactional:order-delivered:<shipment-id>`.

Keys are derived from internal immutable UUIDs, not customer contact data. The corresponding provider-delivery key is derived from the created `order_message` ID and remains stable across retries.

## Authoritative Event Integration

### Payment confirmation

Both `checkout.session.completed` and `payment_intent.succeeded` use the existing successful-payment handler. After the order is verified as paid, the handler inserts the confirmation intent in the same transaction. The `already_paid` replay path also performs an idempotent insert so an older paid order or interrupted prior deployment can recover a missing intent without creating a duplicate.

### Refund completion

The existing `customer_notification` refund effect remains the refund ledger's atomically durable request. Its scheduler promotes that effect into a generic `refund.completed` intent idempotently. Add an explicit nullable, unique `transactional_notification_intent_id` foreign key on the effect so recovery does not depend on message metadata. A crash between refund success, intent creation, and message creation is safe: each later worker run resumes the first incomplete stage. An exact existing intent is treated as recovered success. Contact, materialization, and provider terminal outcomes update the effect and intent atomically with guarded transitions. The effect is successful only after provider delivery succeeds.

### Shipment, cancellation, and delivery

The shipment-confirmation transaction inserts `order.shipped` using the shipment ID. Both shipment receipt replay paths idempotently ensure the intent exists before returning, including receipts created before this migration.

Before materialization, a bounded reconciler finds paid cancelled orders and delivered/completed shipments without matching intents and snapshots them under row lock. It excludes unpaid checkout retirement. This provides durable coverage before cancellation/delivery routes exist and recovers future writers that omit the immediate call. Future writers must call the same intent writer in their transaction to avoid reconciliation delay.

## Contact and Channel Selection

The intent writer resolves only the checkout snapshot as follows:

1. An explicit `email` preference selects the order email only. It never falls back to SMS.
2. Only an explicit `sms` preference presented with appropriate customer-facing transactional-text disclosure selects the order phone. It never falls back to email.
3. The current/legacy `phone` preference is a call/contact preference, not SMS consent. It is unsupported for automated delivery and records `MESSAGE_SMS_CONSENT_UNAVAILABLE` without falling back to email.
4. With no preference, a valid order email may be selected. SMS requires explicit `sms` preference or a future persisted alternate-channel consent flag.
5. An absent or invalid selected contact records `MESSAGE_CONTACT_UNAVAILABLE` for later terminal handling.
6. A valid selected channel without a configured sender terminates with `MESSAGE_CHANNEL_UNAVAILABLE`.

Email is trimmed, lowercased, capped at 254 characters, and format validated. SMS numbers are normalized to E.164 and must contain 8-15 digits after `+`. Checkout currently proves format and snapshot provenance, not ownership of a guest's email or phone; the implementation and UI must not call such contacts identity-verified. Invalid contacts are never inserted into a delivery job. The selected recipient becomes immutable on the intent. Contact values are excluded from logs, order events, error messages, and notification-status APIs.

## Rendering Contract

Rendering is deterministic and versioned. Email and SMS may use channel-specific text, but both communicate the same facts.

- Confirmation includes the public order number, a customer-safe item summary, total and currency, and the order lookup link.
- Cancellation includes the public order number, cancelled status, and lookup link. Internal cancellation reasons are excluded.
- Refund completion includes the public order number, formatted refund amount/currency, and lookup link.
- Shipment includes the public order number, carrier and tracking number when available, a server-derived tracking link when safe, and the order lookup link.
- Delivery includes the public order number, delivered status, and lookup link.

Money is rendered from minor units using the currency's exponent. Different currencies are never combined. Item summaries extract only the explicit product-title snapshot field and quantity, cap titles at 120 characters, cap the list at ten rows, and add an `and N more items` line. Renderers output normalized plain text, remove CR/LF and other control characters from individual fields, cap subjects at 160 characters, email bodies at 10,000 characters, and SMS bodies at 480 characters. They never stringify arbitrary JSON. Customization text, nested snapshots, asset identifiers, private image URLs, addresses, payment identifiers, and internal notes are never rendered. Any later HTML renderer must contextually escape every value and prohibit raw interpolation.

Shipment links are always recomputed from the bounded carrier and tracking number with the existing `deriveTrackingUrl` allowlist. A persisted or provider-supplied `shipments.tracking_url` is never rendered. Unknown carriers may include sanitized plain-text carrier/tracking values but no tracking link. Tracking numbers and URLs are excluded from logs, order events, and notification-status APIs.

Add a backend `ORDER_LOOKUP_BASE_URL` origin setting. It rejects credentials, query parameters, and fragments; production requires HTTPS; development/test HTTP is restricted to loopback hosts. The renderer uses `URL` to replace the path with the fixed `/orders` path and emits no query or fragment. The existing page therefore remains unprefilled and still requires the public order number plus matching checkout contact. The `/orders/lookup` endpoint retains generic not-found responses and gains a Redis-backed, per-source rate limit to reduce order/contact guessing.

## Worker Flow and Fault Tolerance

The existing message-dispatch process performs bounded phases:

1. Reconcile at most 50 eligible paid cancellations and delivered shipments into intents.
2. Promote at most 50 pending refund effects into intents.
3. Claim at most 50 `pending`, `retryable`, or expired `leased` intents with `FOR UPDATE SKIP LOCKED`. Claims use a two-minute lease and increment only `materialization_attempt_count`.
4. Render content and, in one PostgreSQL transaction, ensure the conversation, insert or validate the deterministic `order_messages` row, insert or validate its `message_delivery_jobs` row, link `order_message_id`, and move the intent to `queued`.
5. Claim and deliver existing message jobs using the current provider adapter. The delivery claim query is fixed to reclaim expired `leased` jobs and all completion/failure paths use lease-owner compare-and-set guards.

Materialization retries at most five attempts after 2, 4, 8, 16, and 32 minutes, capped at 60 minutes for any future larger limit. Renderer defects, malformed snapshots, contact errors, sender configuration errors, idempotency conflicts, and attempt exhaustion are terminal allowlisted failures. A crash after message or job insertion rolls back the whole materialization transaction. A crash after claim is recovered by lease expiry.

Provider delivery is at-least-once across the network boundary, not exactly-once. Every attempt carries the stable provider idempotency key, and production provider configuration must honor it. An ambiguous timeout is retryable. A crash after provider acceptance but before local commit may resend the same idempotency key. Provider webhooks reconcile by monotonic state: success is terminal and cannot be downgraded by a later failure; duplicate success is a no-op; failure cannot overwrite a locally/provider-confirmed success. Message job, message, linked intent, and refund effect updates occur in one transaction.

When delivery succeeds or terminally fails, the linked intent is updated in the same transaction as the message/job result. Notification failure never modifies order, payment, refund, fulfillment, or shipment state.

## Admin Observability

Extend the existing admin conversation detail response with a `transactionalNotifications` collection and add an admin-only notification list endpoint with filters for `state`, `kind`, and `failureCode`. The list allows an administrator to discover failures without already knowing the order ID and returns public order number plus the same safe status fields:

- Intent ID and kind.
- State and selected channel, when known.
- Attempt count and last bounded failure code.
- Created, queued, sent, failed, and updated timestamps as applicable.

Do not expose recipient contact, sender contact, body, subject, payload snapshot, tracking number, tracking URL, or lookup URL in either representation. Existing role checks protect both endpoints. Missing-contact and sender-configuration failures are therefore discoverable even when no message was created.

Structured logs use events such as:

- `transactional_notification.intent.created`
- `transactional_notification.materialization.succeeded`
- `transactional_notification.materialization.failed`
- `transactional_notification.delivery.succeeded`
- `transactional_notification.delivery.failed`

Safe fields are request/correlation ID when present, intent ID, order ID, kind, channel, state, `materializationAttemptCount`, `deliveryAttemptCount`, retryable flag, duration, phase, and an allowlisted internal result code. The admin status API exposes the two attempt counts separately. Provider webhook/error values are mapped to canonical internal codes; unknown values become `MESSAGE_PROVIDER_FAILED`. Raw provider messages, response bodies, exception objects, and webhook error text are never persisted, returned, or logged. Defense-in-depth logger redaction covers recipient/sender aliases, subject, tracking number/URL, lookup URL, body, email, and phone.

Operational counters/gauges cover intents created, queued, succeeded, materialization retries/exhaustion, delivery retries/exhaustion, and terminal failures by kind/code, plus oldest pending/retryable age and provider delivery latency. They use no customer data.

## API Compatibility

The order lookup response contract remains unchanged; the existing route receives only additive rate limiting. The notification link targets the unprefilled `/orders` experience. Existing admin messaging fields remain backward compatible; notification detail/list fields are additive.

## Test Plan

### Unit tests

- Render every notification kind for email and SMS.
- Format zero-decimal, two-decimal, and three-decimal currencies from minor units.
- Bound and sanitize item summaries; reject markup/control-character injection and exclude nested/customization/private fields.
- Validate and normalize email and E.164 SMS contacts.
- Prove explicit email never falls back to SMS, explicit SMS never falls back to email, legacy `phone` never sends SMS, and absent preference uses email only.
- Validate lookup origins and generate a fixed plain `/orders` link without contact details, order number, credentials, query, fragment, or secrets.
- Recompute tracking links from the carrier allowlist; reject malicious persisted URLs, unknown carriers, encoded controls, and control characters.
- Map arbitrary provider/webhook errors to allowlisted internal codes.
- Classify transient and permanent failures.

### Database integration tests

- Payment success creates one confirmation intent; Stripe event replays remain one intent and one message.
- Already-paid recovery inserts a missing confirmation intent without changing the order.
- Refund success produces one generic intent and reconciles the explicitly linked refund effect on delivery success/failure. Crashes after refund success and after intent creation recover.
- Shipment confirmation creates one shipment intent; both command replay paths, including a pre-migration receipt, repair a missing intent idempotently.
- Reconciliation creates one intent for a cancellation or delivered shipment only when `paid_at` is present and payment status is `paid`, `partially_refunded`, or `refunded`; it excludes unpaid checkout retirement and inconsistent delivered shipments on unpaid orders.
- Concurrent duplicate source insertion creates one intent. Same-key conflicts in kind, source, payload, or recipient terminate without overwriting data.
- Concurrent workers claim each intent once; expired intent leases atomically replace the owner and increment only the materialization count; expired message-job leases increment only the delivery count and recover after restart.
- Valid contacts queue a message/job; missing or malformed contacts become terminal, admin-visible failures.
- Missing sender configuration becomes an actionable terminal failure.
- Transient materialization/provider failures retry with bounded backoff; renderer/malformed snapshot errors and exhausted attempts stop terminally.
- A provider or contact failure leaves authoritative order/refund/shipment state unchanged.
- Delivery completion and terminal failure update job, message, intent, and refund effect atomically and monotonically across out-of-order webhooks.
- Later customer/profile contact changes do not redirect an existing intent.

### API and privacy tests

- Admin detail and filtered list expose safe notification status fields and make terminal failures discoverable without a known order ID.
- Non-admin callers cannot read notification status.
- Lookup requests are rate limited while preserving generic lookup failures.
- Canary values never appear in logs, order-event metadata, webhook errors, notification status APIs, or arbitrary snapshot rendering. Stored provider-delivery rows contain only the expected private recipient/content fields.
- Existing admin messaging, refund, Stripe webhook, and shipment tests continue to pass.

### End-to-end test

Using the isolated local E2E database and a fake messaging provider:

1. Complete payment for a guest checkout.
2. Run the dispatcher and assert one confirmation is delivered with the correct safe summary and lookup link.
3. Confirm shipment and assert one tracking update is delivered.
4. Complete a refund and assert one refund update is delivered.
5. Commit an authoritative paid cancellation and delivered shipment, run reconciliation, and assert the respective updates; prove an unpaid retired checkout generates none.
6. Replay each source event and rerun workers; assert no duplicate messages.
7. Simulate a transient provider failure, an ambiguous timeout, worker restart after claim, and terminal exhaustion.
8. Repeat with a missing contact and verify business state remains valid while the filtered admin API discovers the actionable failure.

## Migration and Rollout

1. Apply an additive migration defining the intent status/kind enums, table checks above, `orders`/`order_messages` foreign keys, unique idempotency and message-link indexes, partial ready-work and expired-lease indexes, `payload_version > 0`, object payload enforcement, and the refund-effect intent foreign key. Migration integration tests verify a clean database and upgrade from the current messaging schema.
2. Deploy application and worker code with `ORDER_LOOKUP_BASE_URL` configured.
3. Run the dispatcher continuously or on a schedule at least as frequently as the existing message jobs require.
4. Monitor oldest pending/retryable age, retry exhaustion, terminal failure count by bounded code, and provider delivery latency.
5. Migrations are forward-only. Rollback means reverting application/worker code while retaining the additive schema. The prior worker continues draining already-materialized `message_delivery_jobs` but cannot materialize pending intents; those remain durable until the new worker is restored. Producers may be disabled without deleting work. A later reviewed cleanup migration is required to remove schema.

## Acceptance Mapping

- Authoritative success: intent insertion is owned by the existing payment-success transaction.
- Safe confirmation content: versioned renderer includes order ID, item summary, total/currency, and lookup link only.
- Lifecycle updates: shared contract covers cancellation, refund, shipment, and delivery.
- Tracking: shipment payload carries carrier/tracking and only server-derived safe URLs.
- Snapshot preference: contact/channel resolver uses checkout snapshots and supported preference.
- Durable delivery: generic intents feed the issue #12 message/job outbox; provider calls remain outside webhooks.
- Idempotency: unique semantic keys protect source replay, retry, and restart.
- Observability/privacy: additive admin status plus redacted structured logs.
- Business-state isolation: asynchronous failures do not reverse authoritative transitions.
- Missing contacts: terminal, actionable intent state is visible to admins.
- Test coverage: unit, database integration, API/privacy, and isolated E2E cases cover success and failure paths.

## Review Gate

Implementation begins only after three independent reviewers approve:

1. Transactional integrity, outbox, and idempotency.
2. Security, privacy, contact selection, and customer-safe content.
3. Test completeness, operations, observability, and rollout safety.

Approval recorded after revision:

- Transactional integrity reviewer: approved.
- Security and privacy reviewer: approved.
- Testing and operations reviewer: approved.
