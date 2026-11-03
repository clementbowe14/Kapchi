# Issue 29: Pirate Ship Shipping Export Workflow

Status: Approved for implementation

## Objective

Let an authorized Kapchi administrator select ready-to-ship U.S. orders, confirm package measurements, download a deterministic Pirate Ship-compatible CSV batch, and record the purchased label against the exact exported shipment. Exporting never buys a label and never marks an order shipped.

## External Constraints

Pirate Ship has no public API. Its supported bulk workflow accepts a spreadsheet with separate address columns. Per-row weight and dimensions are supported, but package type, extra services, and customs settings apply to the whole upload. Kapchi therefore uses the documented spreadsheet workflow only and does not call, scrape, or reverse-engineer private Pirate Ship endpoints.

References:

- <https://support.pirateship.com/en/articles/2309246-does-pirate-ship-have-an-api>
- <https://support.pirateship.com/en/articles/1068428-how-do-i-upload-address-spreadsheets-into-pirate-ship>
- <https://support.pirateship.com/en/articles/2797613-how-do-i-upload-a-spreadsheet-with-different-weights-and-dimensions>
- <https://support.pirateship.com/en/articles/4143612-can-i-export-a-report-of-my-shipment-history>

## Scope

This issue includes:

1. Collecting a U.S. shipping address in Stripe Checkout and persisting its normalized snapshot from the signed `checkout.session.completed` event.
2. Bulk selection of ready-to-ship orders in the admin orders dashboard.
3. Server-authoritative preflight, package measurements, and atomic export creation.
4. Immutable, versioned CSV row snapshots with a checksum and bounded retention.
5. A manual Pirate Ship upload/review handoff with explicit approval boundaries.
6. Binding manual tracking confirmation to the exact exported shipment.
7. A runbook, structured observability, unit/integration/E2E coverage, and a staged rollout.

This issue excludes Pirate Ship credentials/APIs, automated sign-in/rates/purchase, international/customs exports, multi-package fulfillment, insurance, package-type selection, label storage, and tracking-file import. Guarded manual tracking entry satisfies the issue's “import or enter” criterion. The optional browser assistant remains issue #30.

## Required Checkout Dependency

Production currently cannot reliably start because Checkout does not collect or persist a shipping address. This issue closes that prerequisite instead of exporting fixture-only orders.

1. Stripe Checkout Session creation sets `shipping_address_collection.allowed_countries` to `['US']`.
2. The signed `checkout.session.completed` event is authoritative for shipping name/address.
3. Normalize Stripe's address to `line1`, optional `line2`, `city`, `state`, `postalCode`, and `country: 'US'`. Name, line 1, city, two-letter state, and ZIP are required.
4. `handleCheckoutSessionCompleted` always commits authoritative payment state. A valid address is written in the same transaction even if `payment_intent.succeeded` marked the order paid first. It never replaces a non-null address with null or data from another Session.
5. Add `orders.shipping_address_status = valid|missing|invalid` and an allowlisted `shipping_address_issue_code`. A semantically missing/malformed address is a terminal, admin-visible fulfillment issue, not a retryable webhook error. Only transient database/infrastructure failures retry.
6. The durable webhook projection contains normalized shipping fields only while a transient retry is possible. Processing success, terminal address failure, or bounded retry exhaustion replaces it with a PII-free projection. The order is the single durable business record.
7. Webhook logs, errors, hashes, and metrics never include address fields. Tests cover event ordering, duplicates, valid/missing/malformed addresses, transient retries, bounded exhaustion, and projection scrubbing.
8. Historical/test orders without an address remain visible but cannot start production or export. No fabricated backfill is permitted.

## User Flow

1. The administrator selects eligible rows in the orders dashboard.
2. **Prepare shipping export** performs one batch preflight and opens a dialog listing public order numbers, issues, and package fields.
3. The administrator enters weight in ounces and length, width, and height in inches. Existing values from the single active export shipment are prefilled.
4. Submission revalidates every order under lock. Any invalid row rejects the whole batch.
5. Kapchi commits an immutable batch, then downloads `kapchi-pirate-ship-<batch-id>.csv` through an authenticated request.
6. The administrator explicitly approves disclosing that exact batch to Pirate Ship, signs in themselves, uploads it, selects one package type/default package for the batch, maps columns, and reviews overrides and warnings.
7. Material address corrections must first be applied in Kapchi, then a new export is created. Purchase from a stale, external-only correction is prohibited.
8. The administrator explicitly approves purchase in Pirate Ship.
9. The administrator returns to Kapchi, enters carrier/service/tracking against the exact exported shipment, and confirms. Only this guarded action marks the order shipped.

## Eligibility

Each requested order is locked and revalidated in one transaction. It is eligible only when:

- Order and primary fulfillment are both `ready_to_ship`.
- Payment is `paid` or `partially_refunded`, and `paid_at` exists.
- `expectedRevision` matches.
- The fulfillment snapshot has a nonblank recipient and U.S. destination with line 1, city, two-letter state, ZIP, and `country = 'US'`.
- Customer email exists. Phone is optional and exports blank when absent.
- No purchased/in-transit/delivered/completed shipment or tracking exists.
- At most one active reusable `label_pending` or `failed` shipment exists.
- The order has no active export membership (prepared or unresolved expired).

Duplicate IDs, mixed validity, stale revisions, international/incomplete addresses, conflicting shipments, or active exports reject the whole request. Responses expose public order numbers and bounded codes such as `EXPORT_ADDRESS_INCOMPLETE`, `EXPORT_INTERNATIONAL_UNSUPPORTED`, `EXPORT_ALREADY_PREPARED`, and `EXPORT_REVISION_STALE`.

## Package Contract

Each order submits:

```json
{
  "orderId": "uuid",
  "expectedRevision": 4,
  "package": {
    "weightOunces": 12.5,
    "lengthInches": 10,
    "widthInches": 8,
    "heightInches": 2,
    "description": "Graduation stole"
  }
}
```

- Measurements are finite decimals with at most two decimal places.
- Weight is `0.01` through `2400` ounces; each dimension is `0.01` through `120` inches.
- Description is optional normalized text, at most 120 characters, and is not exported or logged.
- Pirate Ship remains authoritative for carrier/service constraints.
- All rows use an administrator-confirmed Pirate Ship package type/default; CSV measurements override its default per row.

## Shipment Ownership and Re-export

- Export creates or reuses exactly one active `label_pending` shipment per order.
- A `failed` reusable shipment resets to `label_pending`; stale provider IDs, URLs, purchase timestamps, and label metadata are cleared while failure history remains in events/audit metadata.
- Export rejects legacy orders having multiple reusable shipments with `EXPORT_SHIPMENT_CONFLICT`; it never guesses, deletes, or voids history.
- A different idempotency key while a prepared batch exists returns `409 EXPORT_ALREADY_PREPARED`; it never overwrites package data.
- To correct package/address data before purchase, an administrator cancels the prepared batch. Cancellation marks it `cancelled`, clears the shipment's active batch link, and records audit/events without deleting history. A new export may reuse that shipment.
- A shipment with purchased-label/provider/tracking metadata cannot be cancelled or re-exported.
- `POST /admin/orders/:orderId/actions/confirm-shipment` adds optional `shipmentId`. It is required when active export membership exists or multiple candidates exist and must identify that active export shipment. Legacy manual orders with exactly one candidate remain backward-compatible when it is omitted. Existing idempotency receipts replay before new validation, and legacy payload fingerprints remain unchanged.
- The existing arbitrary-text `shipments.export_batch_id` remains as read-only legacy data. Add a separate nullable UUID `active_shipping_export_batch_id` for the new foreign key; do not cast or delete legacy values.

## Guarded Address Correction

`POST /admin/orders/:orderId/actions/correct-shipping-address` requires `fulfillment:write`, active local-admin resolution, `expectedRevision`, normalized U.S. name/address, a bounded reason, and explicit intent confirmation.

- It is allowed only when payment is `paid|partially_refunded`, order status is `paid|in_production|ready_to_ship`, fulfillment is absent or `queued|in_progress|ready_to_ship`, and no purchased-label/provider/tracking metadata exists. Pending-payment, unpaid, cancelled, shipped, completed, refunded, or other terminal states are rejected.
- A prepared export must be cancelled first. An unresolved expired export must be released first.
- Under one transaction it locks the order and any existing primary fulfillment/shipment, revalidates state, updates the order address, sets `shipping_address_status = 'valid'`, clears `shipping_address_issue_code`, updates current fulfillment and unconfirmed-shipment destination snapshots only when those rows exist, increments order revision, and records before/after hashes rather than PII in audit/order events. A paid historical order with no fulfillment is repaired at the order level and can then start production normally; the correction command does not create fulfillment rows.
- The order detail UI exposes this command beside delivery data and explains that a fresh export is required.
- Correction never mutates an immutable batch snapshot or makes a cancelled/expired file downloadable.

## Persistence

Add `shipping_export_batches` with UUID ID, provider `pirate_ship`, format `csv`, mapping version `1`, status `prepared|cancelled|expired`, active actor identity, safe request ID, idempotency-key hash, request fingerprint, row count, file SHA-256, timestamps, and CSV issuance count. `(provider, idempotency_key_hash)` is unique.

Add `shipping_export_batch_items` with batch/order/shipment foreign keys, stable one-based row number, nullable immutable logical `row_snapshot` JSON, `row_sha256`, and an opaque reconciliation-token hash. Unique constraints cover batch/order, batch/shipment, and batch/row. These non-PII relationship rows remain after purge.

Add `shipping_export_active_memberships` with `order_id` primary key, unique `shipment_id`, `batch_id`, and timestamps. A composite foreign key `(batch_id, order_id, shipment_id)` binds it to a matching unique historical item. This child-owned table is the database-enforceable source of one active export per order/shipment; cancellation, successful shipment confirmation, or explicit expired-batch release deletes membership atomically.

Add `shipping_export_mutation_receipts` for batch cancellation/release with batch ID, command, key, fingerprint, PII-free result, and source audit/event identity. Address correction and shipment confirmation reuse `admin_order_mutation_receipts`.

Snapshots intentionally duplicate the minimum PII needed for deterministic re-download. They exclude customization text/assets, internal notes, payment IDs, private URLs, and package description. Downloads serialize only stored snapshots and verify bytes against `file_sha256`; they never query mutable order/shipment values.

PII retention is 30 days. `expires_at = created_at + interval '30 days'`. An idempotent scheduled `shipping:exports:purge` command nulls item snapshots, marks batches `expired`, sets `purged_at`, and retains non-sensitive relationships, hashes, and tokens. Expired/cancelled downloads return `410 EXPORT_BATCH_EXPIRED` or `410 EXPORT_BATCH_INACTIVE` and never regenerate from source.

Expiry does not guess whether an external label was purchased, so active membership remains until an administrator resolves it. From durable batch recovery, the administrator either (a) enters tracking for the exact actively linked shipment, or (b) explicitly certifies no label was purchased and releases the expired batch. Release clears membership and `active_shipping_export_batch_id`, permanently makes that export ineligible for confirmation, records audit/events, and permits re-export. Only the current active prepared or unresolved expired membership may be confirmed; cancelled/released history can never become confirmable again.

## Transaction and Concurrency

1. Resolve an active local administrator with `fulfillment:write`.
2. Acquire an advisory lock from provider plus hashed idempotency key.
3. For an existing key, compare canonical fingerprint and replay or return `409 IDEMPOTENCY_CONFLICT`.
4. Every export-related command uses one global row-lock order: sorted orders, their primary fulfillments, shipments, active memberships, then batch/item rows. Batch commands may read IDs first without locks but must re-read/revalidate after acquiring locks. No command locks these row classes in another order.
5. Validate every row before writes; database uniqueness resolves races with bounded conflicts.
6. Create/reuse shipments, write package/destination snapshots, create batch/items, serialize deterministic CSV, and store its checksum.
7. Set shipment active batch UUID/export timestamp.
8. Record one PII-free `order.shipping_exported` event per order and one `fulfillment:write` audit event.

The mutation changes no order/payment/fulfillment status or order revision. A timeout after commit is recovered by retrying the identical payload with the same key.

Every state-changing endpoint (create, cancel, release, address correction, and shipment confirmation) requires a 16-128 character `Idempotency-Key`, computes a versioned canonical fingerprint, and checks a durable receipt before current-state/revision validation. Exact replay returns the stored PII-free result; different content returns `409 IDEMPOTENCY_CONFLICT`. This makes a committed timeout recoverable even after revision/status changes.

## API Contract

Every endpoint resolves an active local administrator, requires `fulfillment:write`, and returns allowlisted errors without raw Joi/Fastify/database messages or submitted values.

### Preflight

`POST /admin/shipping/export-candidates` accepts 1-100 unique order IDs and returns public number, revision, eligibility/codes, and existing measurements only. It is read-only.

### Create

`POST /admin/shipping/export-batches` requires an `Idempotency-Key` of 16-128 printable ASCII characters and 1-100 package rows. It returns `201`, or `200` on exact replay, with batch ID, filename, mapping version, row count, expiry, and relative download path.

### Download

`GET /admin/shipping/export-batches/:batchId/file` returns private/no-store UTF-8 CSV with BOM, RFC 4180 quoting, and CRLF. “Issued” means server generation/response initiation, not proof the browser received all bytes. Socket aborts do not alter business state; the batch remains retryable until expiry.

### Recovery list and detail

`GET /admin/shipping/export-batches?status=prepared,expired&cursor=...` and `GET /admin/shipping/export-batches/:batchId` return durable PII-free batch metadata, affected public order numbers, exact shipment IDs, expiry/status, and allowed next actions. They support reopening a closed browser/session without relying on in-memory idempotency state.

### Cancel

`POST /admin/shipping/export-batches/:batchId/cancel` requires an idempotency key, `expectedStatus: 'prepared'`, explicit intent `no_label_purchased`, and a bounded reason. Because Kapchi cannot observe Pirate Ship purchase state, the administrator must certify that no label was purchased even when local provider/tracking fields are empty. Cancellation records a durable receipt and audit/order events.

Cancellation immediately disables download. The UI/runbook requires deleting local copies and removing the corresponding Pirate Ship draft before re-export.

### Release expired batch

`POST /admin/shipping/export-batches/:batchId/release` requires an idempotency key, `expectedStatus: 'expired'`, explicit intent `no_label_purchased`, and a bounded reason. It atomically releases active membership and records a durable receipt plus audit/order events. It never restores a file or changes order status.

### Confirm shipment

The existing route accepts `shipmentId`, carrier, optional service, tracking, expected revision, and intent confirmation. `shipmentId` is required for exported/ambiguous orders and optional only for unambiguous legacy manual shipments. It verifies ownership/history, preserves export/package snapshots, and updates only that shipment.

Common codes: `VALIDATION_ERROR`, `ORDER_ACTOR_UNAVAILABLE`, `EXPORT_BATCH_NOT_FOUND`, `EXPORT_BATCH_EXPIRED`, `EXPORT_BATCH_INELIGIBLE`, `EXPORT_ALREADY_PREPARED`, `IDEMPOTENCY_CONFLICT`, and `SHIPPING_EXPORT_UNAVAILABLE`.

## CSV Mapping V1

Exact headers:

1. `Order ID`
2. `Full Name`
3. `Company`
4. `Email`
5. `Phone`
6. `Address Line 1`
7. `Address Line 2`
8. `City`
9. `State`
10. `Zip`
11. `Country`
12. `Weight (Ounces)`
13. `Length`
14. `Width`
15. `Height`
16. `Order Items`
17. `Order Item Count`
18. `Note`
19. `Kapchi Reference`

`Order ID` is public. `Kapchi Reference` is one opaque random reconciliation token mapped server-side to batch/order/shipment; raw UUIDs are not disclosed. `Order Items` contains title/quantity only. `Note` is a fixed marker.

A maintained CSV library handles quoting. Exact post-normalization limits are: Order ID 64, Full Name 100, Company 100 (blank in v1), Email 254, Phone 15 digits, Address lines 128 each, City 100, State exactly 2, ZIP 5 or ZIP+4 (10), Country exactly 2, Order Items 500, Note 64, and Kapchi Reference 64. Required routing/contact fields exceeding limits are rejected; optional phone is digits-only (the U.S. country prefix may be removed) or blank; item summary truncates only at an item boundary and appends `...`. The serialized file limit is 1 MiB in addition to the 100-row limit.

Text is NFKC-normalized; CR/LF/tab/control characters become spaces; repeated whitespace collapses; then limits apply. Shipping-critical fields (name, email, address, city, state, ZIP, country) whose first non-whitespace character is `=`, `+`, `-`, or `@` are rejected rather than modified. Generated order/reference/note fields are constrained to safe alphabets. Product titles use a leading apostrophe only when formula-like because they are descriptive, not routing data. Measurement cells are canonical decimal strings. The runbook requires uploading the generated CSV directly without opening/resaving it in spreadsheet software and includes staged field-fidelity checks for ZIP, phone, quotes, and whitespace.

## Admin Interface

- Selection state lives above desktop/mobile renderers, keyed by order ID and authenticated identity. It clears on sign-out/identity change and removes stale/ineligible IDs after data refresh/filter/page replacement.
- Header select-all affects eligible visible rows and exposes programmatic `indeterminate` state. Checkboxes have unique names containing public order number.
- Preflight requests carry a token and stale responses are ignored when identity/selection changes.
- Dialog requirements: accessible name/description, initial focus, contained tab order, Escape close, trigger focus restoration, focusable linked error summary, `aria-invalid`, `aria-describedby`, and polite live announcements.
- Client state is `idle -> preflighting -> editing -> creating -> creation_unknown/recovering -> created -> downloading -> download_failed/downloaded`.
- One idempotency key/payload fingerprint persists through ambiguous errors. Recovery resubmits the same payload/key. Editing after unknown outcome requires explicitly abandoning recovery and generating a new key.
- Failed file requests retry only `GET` for the existing batch. Blob URLs are revoked. PII/credentials never enter URLs, logs, analytics, or persistent client storage.
- After issue, show batch ID/expiry, PII disclosure and explicit **Open Pirate Ship**, mapping instructions, and order links for exact-shipment confirmation.
- A persistent **Shipping exports** view uses recovery list/detail endpoints to reopen prepared/expired batches, retry download, cancel prepared batches, release expired batches, or enter tracking. Closing the dialog never strands a batch.

## Human Approval and Credential Boundary

1. Before upload, show exact batch ID, row count, destination, and PII disclosure; require explicit action.
2. The administrator signs in. No assistant accesses credentials, cookies, session tokens, password managers, MFA, CAPTCHA, payment controls, or unrelated downloads.
3. Corrections return to Kapchi and require re-export; they are not silently accepted externally.
4. Stop again before purchase/charge and require approval for displayed batch/rates. Approval is never remembered.
5. Browser automation remains issue #30.

## Security and Observability

- Verify JWT admin role, active local admin, and `fulfillment:write` on every export endpoint.
- Serve CSV with `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`; never place it in public storage.
- Route error mappers expose only allowlisted codes, safe field paths, public order numbers, and status.
- Logs/audits/events include safe request/actor/batch/order/shipment IDs, counts, mapping version, result, duration, and checksum. They exclude recipient/contact/address, item titles, descriptions, CSV bytes, keys, tracking, and reconciliation tokens.
- Canary tests search API bodies, captured logs, audit rows, events, and failures for seeded PII/secrets.
- Events: `shipping.export.preflight.completed`, `batch.created`, `batch.replayed`, `batch.rejected`, `batch.cancelled`, `file.issued`, `file.issue_failed`, `batch.purged`.

## Test Plan

### Unit

- Stripe address normalization, Session shipping collection, event-order-independent persistence, terminal address issues, transient retries, and projection scrubbing.
- Package bounds, stable fingerprints, exact immutable row/hash.
- Exact CSV bytes/headers/BOM/CRLF/quoting, routing-field rejection, digits-only phone, ZIP, every field/file bound, and private-field exclusion.

### Backend integration

- Real Fastify/PostgreSQL happy path creates one batch/active shipment per order atomically.
- Same-key concurrency returns one batch; different keys yield one batch plus one bounded conflict without overwritten measurements.
- Committed timeout recovers with same key and identical bytes.
- Cancel, release, correction, and confirmation exact replays return durable receipts after state/revision changed; conflicting fingerprints reject.
- Concurrent export/cancel/release/correction/confirmation operations obey the global lock order, avoid deadlocks, and produce one valid terminal result.
- Historical bytes remain identical after order changes; cancelled history remains and cancelled files return 410.
- Stale revision, malformed/international address, missing contact, conflicts, or invalid package leaves no partial state.
- Failed shipment reset clears stale provider fields; confirmation targets exact `shipmentId`.
- Address correction locks and updates all current snapshots only after cancellation/release, increments revision, and never changes historical snapshots.
- Purge removes only PII, retains relationships/token hashes, is idempotent, and returns 410 without regeneration.
- Expiry before first issue, after issue but before purchase, and after external purchase/before tracking each offer the correct confirm-or-release resolution.
- Confirmation accepts only an active prepared membership or unresolved expired membership. Cancelled/released exports are rejected, including attempts against their historical shipment IDs.
- Legacy text export IDs and duplicate reusable shipments are preserved; conflicted orders are safely rejected. Old shipment-confirmation payloads and idempotency replays remain valid.
- Authorization, safe errors, and PII canaries cover every endpoint/failure.

### Frontend

- Shared selection, indeterminate state, identity/filter/refresh cleanup, stale-response suppression.
- Full state machine, same-key recovery, recovery list/detail after dialog/browser close, GET-only retry, cancel/release, auth expiry, duplicate-click prevention, and blob cleanup.
- Focus lifecycle, linked errors, labels/descriptions/live regions, and narrow layouts.
- PII disclosure, Pirate Ship handoff, and exact-shipment links.

### End to end

1. Complete Stripe Checkout with U.S. address and verify persistence regardless of webhook order.
2. Move two orders through production to ready-to-ship.
3. Select both, enter different measurements, create/download, parse exact mapping, and verify private-data exclusion.
4. Verify orders remain ready-to-ship; replay create and retry file download.
5. Confirm one exact shipment and verify only it becomes shipped.
6. Close/reopen the UI and recover the batch; exercise committed timeout, download retry, cancellation, expiry release, address correction, auth expiry, focus restoration, selection cleanup, stale order, and incomplete/international address failures.

## Rollout and Operations

1. Run a read-only migration preflight reporting legacy text export IDs and orders with multiple reusable shipments; preserve every row and flag conflicts for manual resolution.
2. Apply additive tables/columns only. Do not cast legacy text IDs or add a constraint that existing data cannot satisfy. Deploy/verify the purge command before scheduling it.
3. Deploy backward-compatible backend address persistence, optional shipment-ID confirmation, correction, and export APIs.
4. Smoke-test checkout/webhook/export/recovery and schedule purge.
5. Deploy frontend selection/dialog/recovery/correction/handoff; only this client requires `shipmentId` for exported orders.
6. Upload one homogeneous staging U.S. batch directly, map v1, verify value fidelity/overrides, and stop before purchase without explicit approval.
7. Roll back frontend, then backend; retain additive tables/history and continue purge. Legacy confirmation remains available throughout rollout.

## Acceptance Mapping

- Select ready orders: eligible-only selection plus transactional revalidation.
- Recipient/package columns: immutable versioned snapshots and separate columns.
- Round trip: public number plus opaque reference bound to exact shipment.
- Stable mapping: deterministic bytes/checksum, versioned headers, runbook.
- Credential safety: manual sign-in and no credential/session access.
- Approval: explicit disclosure before upload and stop before purchase.
- Tracking return: guarded manual entry targets exact exported shipment.
- Ship only after confirmation: export leaves order state unchanged.

## Review Gate

Implementation begins only after independent approval from the shipping/data-integrity, security/privacy/CSV, and frontend/accessibility/testing/operations reviewers.
