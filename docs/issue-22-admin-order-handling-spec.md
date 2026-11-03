# Issue #22: Admin Order Handling Workflow

## Status

Approved for implementation on 2026-11-02 after independent backend/security,
frontend/accessibility, and contract/test/release reviews. All three reviewers
returned `VERDICT: APPROVE` for Revision 4.

## Problem

Kapchi now has a protected admin order queue and read-only order detail route,
but an administrator cannot complete the day-to-day fulfillment workflow from
that surface. The backend already supports two guarded lifecycle commands,
internal notes, and an order timeline. It stores shipment records and exposes
them from admin order detail, but it has no command for recording confirmed
tracking and moving a ready order to `shipped`.

Issue #22 therefore needs a narrow backend prerequisite plus a frontend
workflow. The client must never expose a generic status setter or infer that a
shipment exists merely because an export or label-purchase attempt occurred.

## Goals

1. Let an authorized administrator run only the lifecycle action valid for the
   latest order revision.
2. Let an administrator add an internal note without sending it to a customer.
3. Show the newest order history first, with internal and customer-visible
   entries clearly distinguished and deterministic pagination.
4. Let an administrator record confirmed carrier and tracking data and only
   then mark a ready order shipped.
5. Preserve authorization, optimistic concurrency, idempotency, auditability,
   privacy-safe logging, and safe retries across every mutation.
6. Keep the workflow usable at desktop and mobile sizes and test the real
   browser-to-Fastify path without adding an authentication bypass.

## Non-goals

- Composing customer messages; issue #20 owns that UI.
- Refund creation or reconciliation; issue #103 owns refunds.
- Cancellation, address editing, inventory release, delivery confirmation, or
  completion.
- Partial shipments, multiple packages, split fulfillment, or item allocation.
- Pirate Ship export, import, browser automation, rate selection, or label
  purchase; issues #29 and #30 own those workflows.
- Accepting a label URL, provider credential, postage amount, or arbitrary
  shipment metadata from the browser.
- Editing purchased item, customization, customer, or shipping snapshots.

## Reviewable work slices

### Slice A: fulfillment-consistent backend commands

Add one intent-specific shipment command, make the two existing lifecycle
commands keep the primary fulfillment record consistent, and cover those
contracts with tests. This slice is a backend subtask of issue #22 because the
frontend acceptance criteria cannot be completed without a tracking write
contract.

### Slice B: admin order handling frontend

Extend the issue #19 order detail route with lifecycle actions, internal notes,
tracking confirmation, shipment display, and timeline history. This slice
depends on Slice A's documented contract but can be implemented in parallel
against typed fixtures.

## Authorization and route boundaries

- All reads continue to use a current Clerk bearer token and Fastify's
  `orders:read` capability.
- Lifecycle and shipment commands use `fulfillment:write`.
- Internal-note creation uses `order-notes:write`.
- Fastify resolves the Clerk subject to a verified, active local admin user.
  The client never sends an actor ID, role, capability, or permission.
- `401` triggers exactly one forced token refresh. `403` clears protected data
  and renders an accessible permission state without retrying.
- A signed-in non-admin can reach the shell but cannot read or mutate data.

## Backend contract

### Existing reads

- `GET /admin/orders/:orderId` supplies order revision, status, fulfillment,
  contact/shipping snapshots, purchased items, fulfillment records, and
  shipment records.
- `GET /admin/orders/:orderId/timeline?limit=25&sort=occurred_desc&cursor=<opaque>`
  supplies lifecycle events, internal notes, customer-visible messages, and
  refunds newest first. `sort` accepts only `occurred_desc` or
  `occurred_asc`; the default remains `occurred_asc` for compatibility. The
  opaque cursor is bound to the requested sort and cannot be reused with the
  other order.

The frontend parser must validate required fields and use positive allowlists
for timeline payloads and shipment display. It must never recursively dump
metadata, provider identifiers, asset IDs, request fingerprints, or arbitrary
JSON.

### Existing lifecycle commands

- `POST /admin/orders/:orderId/actions/start-production`
- `POST /admin/orders/:orderId/actions/mark-ready-to-ship`

Each request sends an `Idempotency-Key` header and:

```json
{
  "expectedRevision": 3,
  "reason": "Optional internal audit reason"
}
```

The UI exposes these commands only for their exact valid source state, but the
backend remains authoritative and returns `409` for stale or invalid state.
Both commands must also update primary fulfillment number 1 in the same
transaction:

- `start-production` creates the primary fulfillment when absent, copying the
  immutable item/address snapshots, or requires an existing primary
  fulfillment to be `queued` before updating it to `in_progress`. Creation
  requires `orders.shipping_address` to be a JSON object; a missing address is
  `ORDER_TRANSITION_NOT_ALLOWED`, never a fabricated empty object;
- `mark-ready-to-ship` requires primary fulfillment number 1 to be
  `in_progress` and updates it to `ready_to_ship` with `ready_to_ship_at`;
- neither command changes shipment, provider, label, or payment fields.

Their exact success payload is:

```ts
type LifecycleMutationResponse = {
  command: "start_production" | "mark_ready_to_ship";
  fulfillmentStatus: "in_progress" | "ready_to_ship";
  orderId: string;
  orderStatus: "in_production" | "ready_to_ship";
  paymentStatus: "paid" | "partially_refunded";
  replayed: boolean;
  revision: number;
  transitionedAt: string;
};
```

### Existing internal-note command

`POST /admin/messages/orders/:orderId/notes` receives an `Idempotency-Key`
header and `{ "body": "..." }`. The body is trimmed, 1-10,000 characters, and
stored as an internal message. It is not delivered by a provider and must never
appear in customer order APIs or application logs.

### New shipment-confirmation command

Add:

`POST /admin/orders/:orderId/actions/confirm-shipment`

Headers:

- current Clerk bearer token;
- `Idempotency-Key`, 1-128 characters.

Body:

```json
{
  "expectedRevision": 4,
  "carrier": "USPS",
  "carrierService": "Priority Mail",
  "trackingNumber": "9400111899223856928499",
  "reason": "Optional internal audit reason"
}
```

Validation:

- `expectedRevision` is a non-negative integer.
- `carrier` and `trackingNumber` are trimmed required strings of 1-100 and
  1-200 characters respectively. All three shipment strings reject ASCII
  control characters.
- `carrierService` is optional, trimmed, and at most 100 characters.
- `reason` is optional; a non-empty trimmed value is 3-500 characters.
- Unknown fields are rejected.

The browser never supplies a tracking URL. The server normalizes recognized
carrier aliases and derives an HTTPS link for USPS, UPS, FedEx, or DHL from the
validated tracking number. An unrecognized carrier may still be recorded, but
its tracking URL is `null`. No persisted legacy URL is trusted for customer
output.

Carrier matching trims, collapses internal ASCII whitespace, and compares
case-insensitively. These are the complete aliases and canonical values:

| Aliases | Canonical carrier | Exact template (`value` is encoded) |
| --- | --- | --- |
| `usps`, `united states postal service` | `USPS` | `https://tools.usps.com/go/TrackConfirmAction?tLabels=${value}` |
| `ups`, `united parcel service` | `UPS` | `https://www.ups.com/track?tracknum=${value}` |
| `fedex`, `fed ex`, `federal express` | `FedEx` | `https://www.fedex.com/fedextrack/?trknbr=${value}` |
| `dhl`, `dhl express` | `DHL` | `https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=${value}` |

Tracking identity comparison uppercases and removes ASCII spaces and hyphens;
the original trimmed value is stored for display. URL templates use
`encodeURIComponent` on that display value, then parse the result and verify
protocol `https:`, the exact host above, no credentials, and no fragment. The
templates are frozen by the table above. A failed construction stores `null`
and is never customer-clickable.

Preconditions:

- order status is `ready_to_ship`;
- primary fulfillment number 1 exists and is `ready_to_ship`;
- payment status is `paid` or `partially_refunded` and `paid_at` exists;
- the stored shipping-address snapshot is a JSON object;
- the expected revision matches the locked order;
- no active shipment already records a different confirmed tracking identity
  for this single-shipment MVP workflow.

`in_transit`, `delivered`, and `completed` are confirmed statuses.
`label_pending`, `label_purchased`, and `failed` are reusable candidates;
`voided` is immutable history. For a normal transition, a reusable candidate
with a non-empty, different normalized tracking identity causes
`SHIPMENT_ALREADY_CONFIRMED`; the command does not allocate around it.

Atomic effects:

1. Acquire the existing per-order/idempotency advisory lock, then lock the
   order, its fulfillments ordered by fulfillment number, and its shipments
   ordered by shipment number. Verify the actor again inside the transaction.
2. Replay an identical persisted request fingerprint without duplicating a
   shipment, revision, or event; reject key reuse with different input.
3. Before expected-revision and `ready_to_ship` preconditions, check for a
   confirmed shipment. If its normalized carrier/tracking identity matches and
   both order and primary fulfillment are already `shipped`, persist the new
   idempotency key/fingerprint and the original result snapshot, then return
   HTTP `200` with `replayed: true`. This cross-key semantic replay creates no
   event and does not change revision. A different confirmed identity is a
   conflict. All non-replay paths then enforce every listed precondition,
   including expected revision.
4. Normalize carrier and tracking identity for comparison. Reuse the first
   shipment in `label_pending`, `label_purchased`, or `failed` only when it is
   not shipped/delivered/completed and its tracking number is empty or
   normalized-equal. Preserve all label, export, provider, postage, package,
   and provider-metadata fields while updating only lifecycle/tracking fields.
5. A `voided` row is immutable. When only voided rows exist, insert the next
   shipment number (`max(shipment_number) + 1`), preserving the unique
   `(order_id, shipment_number)` constraint. If no row exists, insert shipment
   number 1.
6. Set the selected shipment to `in_transit`, set its normalized carrier,
   service, tracking number, server-derived tracking URL, destination
   snapshots, primary fulfillment ID, and `shipped_at`. Manual confirmation
   does not set `imported_at`.
7. Update primary fulfillment number 1 to `shipped` and set its `shipped_at`.
   Update the order to `shipped/shipped`, set `shipped_at`, increment revision
   exactly once, and leave payment state unchanged.
8. Append one actor-attributed `order.shipment_confirmed` event with safe
   before/after state, shipment ID, carrier, revision, and the optional audit
   reason in protected event metadata. Admin/customer serializers never return
   the reason, and logs never record it.

A migration adds `admin_order_mutation_receipts` for this command with `id`,
`order_id` (cascade FK), `command` (restricted to `confirm_shipment`),
`idempotency_key` (1-128), `request_fingerprint`, `result` (JSON object),
`source_event_id` (FK to the original shipment-confirmation event), and
`created_at`. `(order_id, idempotency_key)` is unique, matching the existing
per-order idempotency scope. The original successful transition inserts its
event and receipt in the same transaction. Exact-key replay locks the receipt,
compares its fingerprint, and returns its validated result; a mismatch is
`IDEMPOTENCY_CONFLICT`. Cross-key semantic replay locks the source event and
inserts a second receipt referencing it with the new key/fingerprint and same
result snapshot. Receipt insertion, shipment/order reads, and response happen
in one transaction; a uniqueness race re-reads and validates the winning
receipt. Receipts never appear in timeline or customer/admin read DTOs.

Response:

```json
{
  "command": "confirm_shipment",
  "fulfillmentStatus": "shipped",
  "orderId": "uuid",
  "orderStatus": "shipped",
  "paymentStatus": "paid",
  "replayed": false,
  "revision": 5,
  "shipment": {
    "carrier": "USPS",
    "carrierService": "Priority Mail",
    "id": "uuid",
    "shippedAt": "2026-11-02T18:00:00.000Z",
    "trackingNumber": "9400111899223856928499",
    "trackingUrl": "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223856928499"
  },
  "transitionedAt": "2026-11-02T18:00:00.000Z"
}
```

Both customer reads, `POST /orders/lookup` and `GET /orders/me`, return a
`tracking` object containing only `carrier`, `trackingNumber`, and
`trackingUrl`, or `null`. Select the latest shipment whose status is
`in_transit`, `delivered`, or `completed`, ordered by `shipped_at DESC NULLS
LAST`, `shipment_number DESC`, then `id DESC`. `trackingUrl` is emitted only
when it can be re-derived from a recognized carrier and valid tracking number;
legacy database URLs are suppressed. Customer responses never return label
paths, provider shipment IDs, postage, shipment history, or internal metadata.

### Backend errors and observability

- `400 VALIDATION_ERROR`: malformed fields.
- `401/403`: shared authentication/authorization failures.
- `404 ORDER_NOT_FOUND`: unknown order.
- `409 ORDER_REVISION_CONFLICT`: stale detail.
- `409 ORDER_TRANSITION_NOT_ALLOWED`: invalid lifecycle state.
- `409 IDEMPOTENCY_CONFLICT`: key reused with different input.
- `409 SHIPMENT_ALREADY_CONFIRMED`: a conflicting confirmed shipment exists.
- `503 ADMIN_ORDERS_UNAVAILABLE` plus bounded `Retry-After`: recognized
  database availability failure.

Completion logs include event name, request ID, order ID, command, replay flag,
revision, and resulting states. Logs exclude contact data, addresses, tracking
numbers/URLs, note bodies, audit reasons, idempotency keys, and request bodies.

## Frontend component design

### Detail layout

Keep the existing compact operational layout. Add two full-width bands after
the order summary and purchased items:

1. `OrderActionsPanel`: current next action and shipment information.
2. `OrderHistoryPanel`: note composer followed by the chronological timeline.

Do not place cards inside cards. At narrow widths, labels and controls stack;
at 320 CSS pixels no field, status, or action may overflow.

### OrderActionsPanel

- Shows at most one primary lifecycle command according to this complete
  decision table. Any condition not listed produces no mutation control:

| Action | Order status | Fulfillment status | Payment | `paidAt` | Address | Active shipment |
| --- | --- | --- | --- | --- | --- | --- |
| Start production | `paid` | absent or `queued` | `paid` or `partially_refunded` | required | order address object required | ignored |
| Mark ready to ship | `in_production` | `in_progress` | `paid` or `partially_refunded` | required | fulfillment snapshot object required | ignored |
| Confirm shipment | `ready_to_ship` | `ready_to_ship` | `paid` or `partially_refunded` | required | fulfillment snapshot object required | no `in_transit`, `delivered`, or `completed` shipment |

- Other states show a neutral explanation rather than disabled impossible
  commands. Invalid payment/`paidAt` says payment must be confirmed; missing
  address says a shipping address is required; a mismatched fulfillment says
  the workflow state must be refreshed; a confirmed shipment says shipment is
  already recorded; terminal/cancelled/refunded states say no fulfillment
  action is available. Copy never exposes internal codes.
- Start/ready commands open a compact confirmation dialog that names the exact
  state change. An optional audit-reason textarea is clearly labeled internal.
- Confirm shipment opens a form with persistent labels for carrier, service,
  and tracking number. It states that confirmation marks the order shipped and
  does not purchase a label.
- Every modal has `role="dialog"`, `aria-modal="true"`, a visible heading and
  description wired by `aria-labelledby`/`aria-describedby`, trapped focus,
  and initial focus on Cancel or the first field. Before dispatch, Escape,
  Cancel, and the close control dismiss it. Once dispatch begins it becomes
  non-dismissible and all form/dismiss controls are disabled until settlement.
  Successful completion is announced and focus returns to the action-panel
  heading when the original action no longer exists.
- Current shipments are shown from a strict display DTO only. Recognized HTTPS
  tracking URLs use `rel="noreferrer noopener"` and open in a new tab.
- Dialogs have a bounded viewport height with an internal scroll region,
  wrapping content, full-width mobile controls, and no horizontal overflow at
  320 CSS pixels or under 200% text zoom.

Client validation matches the backend before dispatch:

- audit reason is optional, but a non-empty trimmed value is 3-500 characters;
- carrier is trimmed 1-100 characters;
- carrier service is optional and at most 100 trimmed characters;
- tracking number is trimmed 1-200 characters;
- shipment strings reject control characters.

Field errors use `aria-invalid` and `aria-describedby`. Values survive
validation, conflict, network, and availability errors and clear only after a
success/replay has been confirmed and fresh detail is available.

### InternalNoteComposer

- Lives under a visible `Internal note` heading and states that customers
  cannot see the note.
- Uses a labeled textarea, character counter, `Add note` command, and no rich
  HTML.
- Whitespace-only input is invalid; validation and the counter use the trimmed
  1-10,000 character body. Errors are associated with the textarea using
  `aria-invalid` and `aria-describedby`.
- The body remains in the form after a failed request and clears only after a
  confirmed success/replay.
- The generated idempotency key remains stable for retries of unchanged text
  and rotates after success or after the text changes.

### OrderHistoryPanel

- Loads independently from order detail so a timeline failure does not hide
  order or action controls.
- Requests `sort=occurred_desc` and displays newest-to-oldest entries, so a
  first-page reload after mutation always contains the newest event. Entries
  show an allowlisted type, timestamp, actor display name, and a visible
  `Internal` or `Customer visible` label. Actor IDs are never displayed;
  missing names fall back by actor type to `Store admin`, `Customer`, or
  `System`.
- Internal notes may display their exact body to the admin. Customer messages
  may display subject/body/status, but are visually distinct and have no reply
  control in issue #22.
- Lifecycle entries show only allowlisted event type and from/to state labels.
- Refund entries show status and per-entry minor-unit amount/currency without
  combining currencies.
- `Load more history` uses the opaque cursor, de-duplicates by entry ID, and
  preserves existing entries on failure.

Empty history, no shipments, and no available action each have distinct,
neutral empty states.

## Frozen frontend contracts

The backend timeline query itself projects only the fields below. It never
serializes event metadata, actor IDs, provider/failure identifiers, refund
reasons, request fingerprints, mutation result snapshots, or arbitrary JSON.
Parsers reject malformed required fields, ignore additional top-level server
fields for forward compatibility, and give components only these mapped views:

```ts
type ShipmentStatus =
  | "label_pending" | "label_purchased" | "in_transit" | "delivered"
  | "completed" | "voided" | "failed";

type AdminShipmentView = {
  id: string;
  shipmentNumber: number;
  status: ShipmentStatus;
  carrier: string | null;
  carrierService: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
};

type TimelineActorType = "admin" | "customer" | "system";
type TimelineVisibility = "internal" | "customer_visible";
type TimelineEventType =
  | "order.production_started"
  | "order.ready_to_ship"
  | "order.shipment_confirmed"
  | "order.updated";
type TimelineState =
  | "pending_payment" | "paid" | "in_production" | "ready_to_ship"
  | "shipped" | "completed" | "cancelled" | "refunded"
  | "unpaid" | "checkout_started" | "failed" | "partially_refunded"
  | "not_started" | "queued" | "in_progress" | "delivered";

type TimelineView =
  | { kind: "event"; id: string; occurredAt: string; visibility: "internal"; actorType: TimelineActorType; actorName: string; eventType: TimelineEventType; from: TimelineLifecycleState | null; to: TimelineLifecycleState | null }
  | { kind: "internal_note"; id: string; occurredAt: string; visibility: "internal"; actorType: "admin" | "system"; actorName: string; body: string; status: "sent" }
  | { kind: "message"; id: string; occurredAt: string; visibility: "customer_visible"; actorType: TimelineActorType; actorName: string; channel: "email" | "sms"; direction: "inbound" | "outbound"; status: "draft" | "queued" | "sent" | "failed"; subject: string | null; body: string }
  | { kind: "refund"; id: string; occurredAt: string; visibility: "internal"; actorType: "admin" | "system"; actorName: string; amountMinor: number; currency: string; status: "pending" | "succeeded" | "failed" };

type NoteResponse = {
  id: string;
  body: string;
  channel: "internal_note";
  createdAt: string;
  direction: "internal";
  failedAt: null;
  senderType: "admin";
  sentAt: string;
  status: "sent";
  subject: null;
};

type TimelineLifecycleState = {
  orderStatus: Extract<TimelineState,
    "pending_payment" | "paid" | "in_production" | "ready_to_ship" |
    "shipped" | "completed" | "cancelled" | "refunded">;
  fulfillmentStatus: Extract<TimelineState,
    "not_started" | "queued" | "in_progress" | "ready_to_ship" |
    "shipped" | "delivered" | "cancelled">;
};
```

The server maps any unrecognized event type to `order.updated`, any unknown
actor type to `system`, and parses existing composite event values such as
`paid/queued` into the structured `from`/`to` objects above. A composite must
contain exactly one allowlisted order status, `/`, and one allowlisted
fulfillment status; otherwise that side is `null`. Rows with an
unknown kind, visibility, message enum, invalid currency, invalid amount, or
unknown shipment status are omitted from the admin response and counted in a
privacy-safe warning log. Event rows expose only `eventType` and the structured
`from`/`to` states; refund rows never aggregate currencies.

Shipments display newest shipment number first, then ID as a deterministic
tie-breaker. `voided` and `failed` rows are visibly historical, pending rows do
not show a tracking link, and only `in_transit`, `delivered`, or `completed`
rows may expose the server-derived link.

Lifecycle and shipment mutation responses use the exact command response
shapes documented above. Internal-note creation returns the message directly,
not a wrapper: HTTP `201` means created and HTTP `200` means an idempotent
replay. The note parser derives replay from the HTTP status; it does not expect
a `replayed` field. Note errors are exactly `400 VALIDATION_ERROR`, shared
`401`, `403 MESSAGE_ACTOR_UNAVAILABLE`, `404 ORDER_NOT_FOUND`,
`409 MESSAGE_IDEMPOTENCY_CONFLICT`, and a recognized database-availability
`503`; all use client-owned copy. Timeline sort/cursor mismatch is
`400 INVALID_CURSOR`. Unknown error codes fall back to generic copy for their
HTTP class and are never rendered verbatim.

## Mutation state and retry behavior

- Generate cryptographically random UUID idempotency keys in the browser; do
  not persist them to local storage or log them.
- Keep the same key only while retrying the same unchanged intent in the same
  mounted form. Rotate it when relevant input changes or a mutation succeeds.
- Send the latest visible `revision` as `expectedRevision`.
- After success or idempotent replay, refetch order detail and the first
  timeline page. Do not claim success from optimistic state alone.
- On `409 ORDER_REVISION_CONFLICT`, close no data, show that the order changed,
  refetch detail/timeline, and require a fresh deliberate submission.
- On an invalid transition or conflicting shipment, preserve the server-owned
  state, refetch, and show client-owned safe copy.
- On `503` or network failure, preserve form values and expose an explicit
  retry. Honor a safe integer `Retry-After`; do not automatically replay a
  mutation.
- Every mutation uses an `AbortController` with a 15-second client timeout.
  Timeout is an unknown outcome: the dialog becomes dismissible, the original
  idempotency key and form values are retained, mutation controls remain
  disabled, and the UI requires a read-only detail/timeline refresh. If that
  refresh proves the transition occurred, treat it as accepted; if current
  revision/state proves it did not, enable an explicit retry with the same key.
  An inconclusive/failed refresh keeps mutation controls disabled.
- Identity change, sign-out, `401`, or `403` aborts requests and immediately
  removes detail, timeline, form values, and mutation success state.

`AdminOrderDetailClient` owns all protected detail, timeline, form, and
mutation state. Every request captures an identity-and-order epoch; an aborted
or late result from an older epoch cannot update state. If a mutation succeeds
but either verification read fails, show `Update accepted; latest state
unavailable`, disable all further mutation controls, preserve non-sensitive
input until the mutation result is understood, and offer an explicit read-only
refresh. That refresh never automatically replays the mutation.

## Security and privacy

- Render all customer, note, and timeline text as React text, never HTML.
- Do not place contact data, addresses, tracking numbers, customization text,
  note bodies, bearer tokens, response bodies, or idempotency keys in console
  output, analytics, traces, screenshots, or error copy.
- Error messages come from a client-owned code/status allowlist.
- The UI never renders arbitrary metadata or recursively traverses payloads.
- A tracking URL is clickable only after strict HTTPS validation; otherwise the
  URL is represented as unavailable while carrier/number remain visible.
- Authenticated Playwright traces, screenshots, and video remain disabled.

## Testing strategy

### Backend unit and route tests

- Shipment input validation and exact capability guard.
- Valid confirmation, actor unavailable, missing order, stale revision,
  invalid state/payment, missing address, and conflicting shipment.
- Start/ready commands create or transition primary fulfillment number 1 in
  lockstep with the order without changing payment/provider fields.
- Shipment confirmation links and transitions primary fulfillment number 1;
  voided rows remain immutable and the next shipment number is selected.
- Candidate reuse for `label_pending`, `label_purchased`, and `failed` preserves
  provider, label, package, postage, and export fields.
- Same-tracking semantic replay with a new idempotency key returns `200`
  without a new revision/event; conflicting active tracking is rejected.
- Identical idempotent replay and mismatched-key conflict.
- Transaction rollback leaves no shipment/order/event partial state.
- Both customer routes select the same latest eligible shipment and expose only
  server-derived, recognized-carrier tracking fields. Legacy/arbitrary URLs
  and ineligible statuses are suppressed.
- Carrier alias normalization, percent-encoded tracking URLs, and exact
  protocol/hostname verification cover all four recognized carriers.
- Timeline output omits audit reasons, metadata, request fingerprints,
  mutation snapshots, provider identifiers, refund reasons, and failure data.
- Ascending/descending pagination is stable and a cursor from one sort is
  rejected with `INVALID_CURSOR` under the other.
- Composite event states are parsed into allowlisted order/fulfillment fields;
  malformed or unknown composites become `null` without leaking raw values.
- Logs omit tracking, addresses, reasons, and keys.

### Backend database integration tests

- One transaction inserts/updates shipment, updates order, increments revision,
  updates fulfillment, and creates one event.
- Concurrent requests with one key replay; different keys against one revision
  produce one success and one revision conflict.
- Conflicting existing tracking is preserved and rejected.
- Row locks are acquired in the documented order and concurrent voided-row or
  label-purchase cases cannot violate shipment numbering.
- Cross-key semantic replay durably records the second key/result without a
  revision or event, including under concurrency.
- Receipt rows enforce per-order key uniqueness, fingerprint conflicts,
  validated result replay, source-event linkage, and transaction rollback.

### Frontend unit and integration tests

- Strict detail, shipment, timeline, and mutation response parsing.
- Exact action eligibility for every order/payment/fulfillment combination.
- Bearer token, one refresh after `401`, idempotency header, latest revision,
  and no role/actor fields.
- Successful start/ready/shipment refetches detail and timeline.
- Note success, replay, validation failure, retry preservation, and key rotation.
- `409`, `503`, malformed response, network failure, `403`, sign-out, and
  identity-change behavior.
- Timeline pagination, de-duplication, safe payload allowlists, entry visibility,
  and independent failure state.
- Dialog focus/keyboard behavior and mobile layout semantics.
- Late detail, timeline, and mutation completions from an older identity/order
  epoch are ignored; protected state clears immediately.
- Mutation success followed by verification-read failure disables mutations
  and exposes only the explicit read refresh.
- Mutation timeout releases the modal trap, preserves the key, and cannot
  resubmit until a conclusive read refresh.

### End-to-end tests

- Deterministic mocked-backend browser path for each lifecycle action, note
  creation, tracking form, timeline, conflict refresh, and mobile overflow.
- Real Fastify/PostgreSQL path with a Clerk test-mode admin: load a deterministic
  paid order, start production, mark ready, confirm shipment, verify timeline,
  and verify both customer-safe reads return tracking.
- No auth bypass. Missing Clerk storage state or local database is a reported
  blocker, never a passing skip.
- Isolation tests reject missing/non-loopback/non-`_e2e`/shared database URLs
  before setup and prove the spawned Fastify process receives the E2E URL.
- The seeded Clerk subject owns the deterministic order through both identity
  columns, and the same storage state verifies `GET /orders/me` tracking.

The real workflow requires a separate `E2E_DATABASE_URL`; setup and the test
Fastify process both override `DATABASE_URL` with that exact value. Validation
parses the URL, allows only loopback hosts (`localhost`, `127.0.0.1`, or
`::1`), requires a database name ending `_e2e`, and rejects equality with the
normal `DATABASE_URL`, `PRODUCTION_DATABASE_URL`, or `STAGING_DATABASE_URL`
when any are present. Missing or invalid isolation fails before migration or
deletion.

A reset script deletes the deterministic order's shipments, events, messages,
and fulfillments, resets its revision/status/timestamps, and recreates its
paid/address/item snapshots. It requires `E2E_ADMIN_AUTH_SUBJECT` and upserts
that Clerk subject as an active local admin. The deterministic order sets both
its legacy `user_id` to that Clerk subject and `authenticated_user_id` to the
upserted local user's UUID. The same Clerk storage state can therefore exercise
admin commands and the authenticated customer `GET /orders/me` without an
authentication bypass. The script is safe to run repeatedly and never accepts
production credentials.

## Implementation ownership after approval

### Agent A: backend fulfillment and shipment confirmation

Owns only backend admin-order mutation types, validation, repository/service
logic, customer-safe tracking serialization, backend docs, the deterministic
database E2E reset/seed script, timeline sort/cursor and minimized DTO work,
and backend tests. It does not edit frontend files. It also owns frozen backend
fixtures consumed by frontend contract tests.

### Agent B: frontend order handling

Owns only `client/features/admin-orders`, issue #22 browser tests, and the
issue-specific component/API tests. It invokes but does not modify Agent A's
database setup script. It implements against this contract and does not edit
backend files.

Shared DTO examples are frozen in backend-owned JSON fixtures. Agent A changes
their server contract and fixture together; Agent B changes its parser tests
against those fixtures. Any contract drift requires both owners to agree in
the PR, rather than silently weakening a parser.

The primary agent integrates both slices, resolves contract drift, runs the
combined suites, and performs the final security/regression review.

## Acceptance criteria mapping

| Issue #22 criterion | Planned evidence |
| --- | --- |
| Open detail from dashboard | Existing issue #19 route plus E2E navigation |
| Contact, address, items, customizations, payment, fulfillment | Existing detail plus regression assertions |
| Update order status | Intent-specific start, ready, and shipment commands |
| Add internal notes | Dedicated note composer and notes endpoint |
| Enter/view carrier and tracking | New confirmation command and shipment band |
| Timeline/history | Paginated, visibility-labeled history panel |
| Separate messages from notes | Distinct timeline entry treatments; no reply UI |

## Definition of done

- Three independent reviewers approve this spec and component design.
- Backend and frontend slices pass lint, typecheck, unit, integration, and
  production builds.
- Authenticated desktop/mobile browser tests and the real Fastify/PostgreSQL
  workflow pass with test-mode credentials.
- No backend authorization or audit boundary is weakened.
- Manual desktop/mobile inspection finds no overlap, overflow, ambiguous
  action, or inaccessible dialog/form behavior.
- The implementation is split into reviewable commits and references issue
  #22 plus the bounded shipment-confirmation backend subissue.
