# Issue #93: Listing Delivery-Timing Estimates

## Status and implementation gate

Revision 2 was approved by three independent reviewers and the product owner on 2026-10-01. Implementation is authorized under the decisions recorded in this document.

Reviewer sign-off:

- Product and accessibility review: **APPROVE**, conditional only on product-owner confirmation.
- Backend and domain architecture review: **APPROVE**, conditional only on product-owner confirmation.
- QA, reliability, security, and observability review: **APPROVE**, conditional only on product-owner confirmation.

## Source issue

GitHub issue [#93](https://github.com/clementbowe14/Kapchi/issues/93): listings should show the product's estimated delivery time based on customization type and priority type.

## Product correction

The listing page does not know the destination, carrier, service level, or actual ship date. It therefore cannot honestly calculate an arrival date. This specification meets the intent of #93 by showing the part Kapchi can support before checkout:

> **Estimated production time: 5-7 business days**

Supporting copy:

> This is an estimate, not a guaranteed delivery date. Shipping time is additional; weekends, holidays, destination, and carrier delays may affect timing.

The selected production priority is preserved through cart and order creation so it is not merely a visual filter. Address-specific shipping or arrival estimates are a separate follow-up.

## Goals

1. Show a production-time range for the selected customization package and production priority.
2. Let customers compare only the priority options actually offered for that package.
3. Keep rules authoritative in the backend and persist the accepted rule snapshot through cart claim and order creation.
4. Avoid false arrival promises, client-side date arithmetic, and hardcoded frontend rules.
5. Provide deterministic tests, accessible controls, and privacy-safe diagnostics.

## Non-goals

- Calendar arrival dates on the listing page.
- Destination, carrier, live rate, label, or transit-time calculation.
- Rush fees. Priority does not affect price in #93; a future fee must use the existing price-variant and Stripe catalog workflow.
- Checkout quote-change acknowledgement, fulfillment `due_at`, holiday-calendar math, or an admin rule editor.
- Guaranteed service levels or compensation.

## Product decisions proposed for approval

1. Customer-facing priority names are **Standard** and **Rush**; stable API codes are `standard` and `rush`.
2. Priority controls production time only and has no price effect in #93.
3. Active backend rules determine whether Rush is available for a package. The client never assumes every package supports it.
4. The UI displays a duration in business days, not calendar dates. A business day means Monday through Friday; the range itself does not perform holiday or timezone calculations.
5. The fixed qualifier is: **“This is an estimate, not a guaranteed delivery date. Shipping time is additional; weekends, holidays, destination, and carrier delays may affect timing.”**
6. Production must not receive invented timing values. Rules are hidden when none are configured. Local development may use the explicit non-production seed values in this document.

## Requirements

### R1. Authoritative and versioned rules

- PostgreSQL stores append-only production-estimate rule revisions associated with a listing customization package.
- An active rule contains a stable priority code, label, minimum business days, maximum business days, display order, default flag, and positive revision number.
- Minimum and maximum values are non-negative integers, and minimum cannot exceed maximum.
- A package has at most one active rule for a priority code and at most one active default rule.
- A default rule must also be active.
- Rule ownership is protected by the existing composite relationship between `listing_customization_sets` and `listings`; application code cannot associate a package with another listing.
- The tuple `(listing_customization_set_id, priority_code, revision)` is unique.
- Rule revisions are immutable after insertion except for lifecycle deactivation. Changes create a new revision and deactivate the previous revision. Existing cart and order snapshots are never rewritten.
- Missing rules produce no guessed fallback.

### R2. Listing API contract

- `GET /listings/:slug` adds `productionPriorities` to each customization package.
- Each option includes only `code`, `label`, `isDefault`, `minimumBusinessDays`, and `maximumBusinessDays`.
- Options are active, ordered, and limited to a maximum of 8 per package.
- The response must contain either exactly one default when options exist or an empty options array.
- No second estimate endpoint is needed because the response contains duration rules rather than time-sensitive dates.
- Existing request IDs, safe 503 behavior, structured request logs, and bounded read retries remain unchanged.
- The client parser rejects malformed codes, negative or reversed ranges, more than 8 options, duplicate codes, and multiple or missing defaults.

### R3. Listing-page interaction

- The estimate appears in the purchase configuration area after the customization selector.
- Production priorities are native radio inputs inside a `fieldset` with the visible legend `Choose production priority`.
- Selecting a customization package selects that package's default priority and discards a priority unavailable for the new package.
- Selecting a different priority immediately updates one complete live-region message: `Estimated production time: X-Y business days.`
- The fixed qualifier is connected to the estimate with `aria-describedby`.
- Selection does not move focus, navigate, fetch again, or cause layout shift.
- If the selected package has no rules, the UI shows `This customization option is temporarily unavailable because we can't calculate its production time. Choose another option or contact Kapchi.` and no duration.
- Missing estimates do not disable the rest of the listing page, but add-to-cart remains disabled until a priority is available because the backend requires an attributable production choice.
- Unavailable listings or fabrics do not show an actionable production promise.

### R4. Cart authority and continuity

- Add-to-cart sends only the selected priority code; it never sends day ranges, labels, rule IDs, revisions, or timestamps.
- In the same database transaction as the cart mutation, the backend validates the active listing/package/priority association, locks the selected rule revision for the read, and writes an authoritative versioned snapshot.
- Cart responses display the priority label and production-time range from that stored snapshot.
- Cart UI keeps the explicit `Estimated production time` label and the fixed non-guarantee qualifier; a priority label and duration alone must not appear contractual.
- Updating quantity does not alter the snapshot. Changing package or priority creates a newly validated snapshot.
- The selected priority code participates in the cart add-item idempotency fingerprint. Reusing an idempotency key with a different priority returns the existing safe idempotency conflict rather than replaying a result for another priority.
- Canonical cart-line identity includes the exact estimate snapshot fingerprint. Lines with different priority codes, rule revisions, or ranges do not merge.
- Guest-to-user cart claim preserves snapshots. Identical lines merge only when their full fingerprint matches; otherwise they remain separate.
- Existing pre-feature cart rows may have null priority/snapshot values and must be reconfigured before checkout rather than receiving an invented default.

### R5. Order snapshot continuity

- The current checkout flow creates orders and order items during checkout preparation, before payment success. That preparation copies the cart's accepted production-estimate snapshot into the order item atomically with the other immutable item snapshots.
- Payment success continues to update status; it does not create or recalculate the production estimate.
- Checkout rejects a line with a missing, malformed, or internally inconsistent snapshot using the existing safe cart-review failure pattern.
- Rule revisions made after a valid cart snapshot do not silently rewrite that customer's non-guaranteed estimate.
- Creating `order_fulfillments`, calculating `due_at`, or promising a calendar completion date is outside #93.

### R6. Snapshot format and integrity

Cart items and order items store a nullable `production_estimate_snapshot` JSON object during rollout and a nullable `production_priority_code` for indexed/operator use.

Snapshot version 1:

```json
{
  "schemaVersion": 1,
  "ruleId": "uuid",
  "ruleRevision": 1,
  "priorityCode": "standard",
  "priorityLabel": "Standard",
  "minimumBusinessDays": 5,
  "maximumBusinessDays": 7,
  "quotedAt": "2026-10-01T16:00:00.000Z"
}
```

- Database checks require an object when non-null and require priority code and snapshot to be both null or both non-null.
- Application validation enforces the complete versioned shape and consistent code before cart reads, claim merges, and checkout preparation.
- The canonical fingerprint is a deterministic hash or canonical serialization of `schemaVersion`, `ruleId`, `ruleRevision`, `priorityCode`, `minimumBusinessDays`, and `maximumBusinessDays`. The customer-facing label and timestamp do not independently determine identity.
- `quotedAt` is generated by an injected backend clock and is for audit only; it does not expire in #93 because the display is a non-guaranteed duration, not a date-bound quote.

### R7. Security, reliability, and privacy

- Priority codes are trimmed lowercase values matching `^[a-z][a-z0-9_]{0,31}$`; arbitrary dates, durations, rule IDs, and snapshots from clients are rejected or ignored.
- A rule must be active and belong to the selected listing/package at cart mutation time.
- No new public endpoint or additional retry surface is introduced.
- Automatic retries remain limited to idempotent listing reads. Cart and checkout writes are not retried automatically.
- Logs must not include customization text, asset metadata, addresses, auth/session tokens, or full snapshot JSON.
- Concurrent activation is protected by partial unique indexes; cart mutation reads and snapshot writes share a transaction and lock the chosen rule row.

### R8. Observability

- Listing serialization emits no per-option log spam; the existing listing request event remains authoritative.
- Cart success logs add safe fields: event name, request ID, listing ID, customization-package ID, priority code, rule ID/revision, and outcome.
- Cart failure logs add a safe error code and retryability without customer content.
- Claim and checkout logs identify snapshot validation/merge outcomes without logging the snapshot body.
- Metrics are not introduced in #93 because this repository has no established metrics pipeline. Structured logs are the supported mechanism; adding metrics requires a separate observability design.

### R9. Rollout and compatibility

- The migration is forward-only and adds nullable cart/order fields so existing rows remain readable.
- Data rules are disabled by absence: packages with no active rules show the unavailable state.
- Production rules require explicit owner-approved values. Local seed data is clearly identified and must never be promoted automatically to production.
- Schema/backend support lands before the UI sends priority codes.
- Existing listing consumers tolerate the additive field; strict Kapchi clients validate it.

## Local-only seed values

These values exist only to make deterministic local and CI tests possible. They are not production promises.

| Customization kind | Standard | Rush |
| --- | --- | --- |
| `blank` | 3-5 business days | 1-2 business days |
| `text_short` | 5-7 business days | 3-4 business days |
| `text_long` | 7-10 business days | 4-6 business days |
| `text_image` | 10-14 business days | 7-9 business days |
| `text_image_trim` | 14-18 business days | 10-12 business days |

## Acceptance criteria

### AC1. Default production estimate

Given an active package with valid rules, when the listing detail loads or the package is selected, then its single default priority is selected and `Estimated production time: X-Y business days` is visible with the fixed qualifier.

### AC2. Customization changes timing

Given packages with different rules, when the customer changes customization package, then the selector resets to the new package's default and the complete estimate message updates without navigation or an API request.

### AC3. Priority changes timing

Given Standard and Rush rules for a package, when the customer selects Rush, then the visible and screen-reader-announced duration changes to the Rush range and focus remains on the selected control.

### AC4. Backend authority

Given a client that submits a valid priority code plus forged dates, ranges, labels, rule IDs, or snapshots, when it adds a cart item, then only the code is accepted and every other estimate field is ignored or rejected; the stored snapshot comes from the locked backend rule.

### AC5. Missing or invalid rules

Given no active valid rule for a package, when it is selected, then the page explains that the option is temporarily unavailable because its production time cannot be calculated, directs the customer to another option or Kapchi, displays no duration, and does not fabricate a default.

### AC6. Cart continuity

Given a cart line created with a valid priority, when the cart is read or quantity changes, then the same label/range snapshot is returned. Lines with different snapshot fingerprints remain separate.

### AC7. Guest claim

Given guest and authenticated lines, when the guest cart is claimed, then exact-fingerprint matches merge quantities and any priority/revision/range difference preserves separate lines without data loss.

### AC8. Checkout and order continuity

Given a valid snapshotted cart line, when checkout preparation creates its order item, then the exact snapshot is copied atomically. Given a missing or inconsistent snapshot, then checkout stops with a safe cart-review error before a Stripe session is created or reused.

### AC9. Accessibility and responsive layout

Given keyboard navigation, a screen reader, mobile width, desktop width, and the longest supported labels/ranges, then the fieldset has an explicit legend, the qualifier is described, exactly one complete update is announced, focus remains stable, and content does not overlap, clip, or resize surrounding controls.

### AC10. Migration and regression safety

Given pre-feature rows and existing listing/cart/claim/checkout tests, when migrations and suites run, then old rows remain readable, they are prevented from checkout until reconfigured, existing behavior remains green, and no local seed timing becomes active production data.

### AC11. Observability and privacy

Given successful and failed cart, claim, and checkout paths, when logs are inspected, then safe rule identifiers and outcomes are present while customer content, uploads, addresses, tokens, and snapshot bodies are absent.

## Technical specification

### Database

Add `listing_production_estimate_rules` with:

- `id uuid primary key`
- `listing_id uuid not null`
- `listing_customization_set_id uuid not null`
- `priority_code varchar(32) not null`
- `label varchar(80) not null`
- `minimum_business_days integer not null`
- `maximum_business_days integer not null`
- `revision integer not null`
- `is_default boolean not null default false`
- `active boolean not null default true`
- `sort_order integer not null default 0`
- timestamps

Use a composite foreign key `(listing_customization_set_id, listing_id)` to the existing unique package/listing key. Add checks for code format, ordered non-negative ranges, positive revision, and `not is_default or active`. Add a unique constraint on `(listing_customization_set_id, priority_code, revision)` plus partial unique indexes for one active code and one active default per package. Revisions are immutable and append-only except for lifecycle deactivation; deactivation plus insertion of the next revision happens transactionally.

Add nullable `production_priority_code` and `production_estimate_snapshot` to `cart_items` and `order_items`, with paired-null and JSON-object checks. Do not backfill existing lines.

### Backend listing contract

Extend listing repository types and detail serialization with:

```json
{
  "productionPriorities": [
    {
      "code": "standard",
      "label": "Standard",
      "isDefault": true,
      "minimumBusinessDays": 5,
      "maximumBusinessDays": 7
    }
  ]
}
```

Read rules with the existing package detail queries or one bounded batched query. Never issue one query per package.

### Client contract and component state

Extend `client/lib/listings.ts` with strict parsing for `productionPriorities`. The configurator state gains `priorityCode`; package selection resolves the default. Add-to-cart includes `priorityCode` only.

The estimate section uses stable dimensions, a fieldset/legend, native radios, a single polite live region, and `aria-describedby` for the qualifier. Format singular `1 business day` correctly; otherwise use `X-Y business days`, collapsing equal bounds to one value.

### Cart, claim, and checkout

The cart service validates and snapshots a rule in the cart mutation transaction. Repository serializers return the safe snapshot fields needed for display. Canonical line comparison and the add-item idempotency fingerprint include the selected priority/snapshot identity.

Claim logic preserves or merges using that full fingerprint. Checkout preparation validates snapshot shape and code consistency before any existing order/provider-session reuse, then copies the snapshot into the newly created order item. Payment-success behavior is unchanged.

## Failure behavior

- Listing repository unavailable: existing safe listing 503 behavior.
- Package has no rules: explain that the customization option is temporarily unavailable, direct the customer to another option or Kapchi, and provide no fallback.
- Invalid/mismatched priority at cart mutation: safe `400 INVALID_PRODUCTION_PRIORITY`.
- Rule deactivated between render and add-to-cart: same safe 400; client refreshes listing data and asks the customer to choose again.
- Snapshot missing or malformed at checkout: safe cart-review conflict; no Stripe session creation/reuse.
- Claim fingerprint differs: preserve separate lines.

## Test plan

### Unit tests

- Rule parser: valid, malformed code, negative/reversed/equal bounds, duplicate options, option cap, missing/multiple defaults.
- Range formatter: singular, equal bounds, normal range, and long labels.
- Configurator reducer: package/default reset and unsupported priority removal.
- Snapshot parser and canonical fingerprint stability.

### Backend and database tests

- Composite ownership, revision uniqueness, and partial unique indexes reject mismatches, duplicate revisions, duplicate active codes/defaults, invalid default state, and invalid ranges.
- Listing detail returns ordered options with exactly one default.
- Cart mutation ignores forged fields, locks/reads the active rule, and snapshots it atomically using an injected clock.
- Cart idempotency replays an identical priority payload and conflicts when the same key is reused with another priority.
- Concurrent rule replacement and cart mutation resolve to one complete rule revision, never mixed fields.
- Claim exact-match merge and mismatch preservation, including concurrent claim/update races.
- Checkout validates before order/provider-session reuse and copies snapshots during order-item creation.
- Logs contain safe identifiers and omit protected content.

### Frontend tests

- Default, package change, priority change, empty-rule, out-of-stock, and add-to-cart payload behavior.
- Keyboard/radio semantics, one live announcement, described qualifier, stable focus, and mobile/desktop layout.
- Cart displays the stored priority and duration snapshot.

### Workflow tests

- Each customization tier with Standard priority can be added and displayed in cart using local seed rules.
- Rush produces its configured duration and distinct cart identity.
- Guest claim preserves or correctly merges snapshots.
- A rule deactivated before add-to-cart requires reselection.
- A malformed legacy cart line cannot create or reuse a provider session.
- Deterministic CI uses provider doubles; optional Stripe sandbox testing remains separate because Stripe behavior is unchanged by this issue.

## Reviewable delivery slices

1. **Compatibility schema and rule repository:** migration, local-only seeds, rule constraints, typed repository, and database tests. No UI exposure.
2. **Backend cart/order support:** priority validation, snapshot/fingerprint, cart serialization, claim behavior, checkout copy, safe errors, structured logs, and integration tests. Nullable compatibility remains.
3. **Listing API and client contract:** additive detail response, strict parser, API tests, and no user-visible control yet.
4. **Listing and cart UI:** priority radio group, estimate message, add-to-cart field, cart display, accessibility/responsive tests, and end-to-end workflow.

Each slice keeps the application deployable. The UI is last so it cannot submit a contract the backend does not yet support.

## Product-owner decisions

Approved for implementation on 2026-10-01:

1. Standard/Rush names and no-fee behavior.
2. The fixed customer-facing qualifier.
3. Whether production should launch only after real timing values are configured.
4. Production remains disabled by missing rules until owner-approved ranges are configured; local-only seed values above are not production defaults.
