# Issue 117: Customer-Facing Store Policies

Status: Approved for implementation by three independent reviewers

## Objective

Publish accessible shipping, returns, privacy, and terms-of-sale pages; expose them throughout the purchase and order journey; and preserve auditable evidence of the exact agreement, acknowledgment, and notices presented when checkout begins. The implementation must reflect current Kapchi behavior without inventing delivery guarantees, refund promises, retention behavior, or legal approval.

## Publication and approval boundary

Policy code and draft copy may be reviewed in a pull-request preview, but a draft must not be represented as effective or released to production. Production release requires an explicit approval record containing:

- approver identity and approval date;
- approval scope (`owner` and, if obtained, `counsel`);
- bundle, checkout-statement, and document versions;
- SHA-256 digest of the checkout statement and every document;
- effective date.

A normal PR approval is not automatically legal-copy approval. The pull request checklist includes a separate, explicit owner-policy approval. Until recorded, previews identify the content as draft and the production release check fails. The publication validator rejects an effective date earlier than the explicit owner approval date or production activation date, preventing retroactive policy claims. The code never invents a fixed production, transit, refund, response, cancellation, support, or retention period. Applicable-law rights are never waived.

## Versioned source of truth

Add one repository-level, append-only policy source containing structured document content and checkout metadata. A deterministic generator produces committed frontend and backend artifacts from that source. CI reruns the generator and fails on a dirty diff, so both builds contain identical canonical metadata values, document ordering, paths, roles, versions, effective dates, and digests.

Every customer-visible copy change, checkout-statement change, or semantic change creates a new version. There is no typographic-only exception. Released source files are never edited or removed; a new release is added and the active pointer advances only with a matching approval record.

The model uses distinct legal roles:

- `agreement`: Terms of Sale;
- `acknowledgment`: Returns and Personalized Goods Policy;
- `notice`: Shipping and Production Policy and Privacy Policy.

The checkout statement is separately versioned and digested. It states that the customer agrees to the Terms of Sale, acknowledges the Returns and Personalized Goods Policy, and was presented the Shipping and Production and Privacy notices. It explicitly does not represent marketing consent, privacy consent, or SMS consent.

Initial version identifiers use an ISO date plus revision, for example `2026-11-03.1`.

## Customer-facing content requirements

### Shipping and production

- Explain that personalized stoles are made to order.
- Treat the production estimate shown for the selected configuration and captured on the order as authoritative for that order.
- Clearly distinguish Kapchi production time from carrier transit time.
- State that carrier estimates are separate and not controlled or guaranteed by Kapchi.
- Explain that rush service affects production only when an eligible rush option is explicitly selected and paid for; it does not guarantee carrier delivery.
- Avoid unsupported destinations or fixed timing promises.

### Returns and personalized goods

- State that personalized/customized goods are generally non-returnable for change-of-mind reasons because they are produced to the customer's selections.
- Preserve remedies required by applicable law and direct customers to the owner-approved support channel for damaged, defective, or incorrect orders.
- Explain that customer-supplied spelling, text, image, fabric, and trim selections are production instructions and must be reviewed before payment.
- State that unpaid customization requests will not be produced.
- Do not invent a return window, cancellation deadline, refund timing, shipping-fee rule, or support address.

### Privacy

- Describe only observed uses: checkout and order fulfillment, transactional order communication, account/order support, and business/legal recordkeeping.
- Inventory actual recipients and purposes from the production data flow: authorized Kapchi administrators; Stripe for hosted payment; Clerk for authentication; Vercel Blob for uploaded customization images; configured database/infrastructure providers that process order or contact data; and configured email/SMS providers for transactional messaging.
- Explain that full card credentials are handled by Stripe rather than stored by Kapchi.
- Explain that contact details and uploaded customization images are currently retained for fulfillment, support, and recordkeeping. Images uploaded to carts that never become orders, including incomplete or abandoned checkouts, may also remain stored because the application has no automated purge. Do not promise deletion, de-identification, an automated purge, or a fixed retention period.
- Describe private-asset access controls factually without claiming an unverified sale/sharing posture or broader regulatory compliance.
- Do not list fraud/security purposes, privacy rights, jurisdictions, or a privacy contact channel unless separately verified and owner/counsel approved.

### Terms of sale

- Explain order formation, displayed pricing/currency, payment through hosted Stripe checkout, and the customer's responsibility for accurate contact, shipping, and customization inputs.
- Incorporate shipping/production and returns rules by visible links.
- Require the customer to have rights to uploaded text/images and prohibit unlawful or infringing content.
- Reserve the ability to reject unpaid, unsafe, unlawful, or technically unproducible customization requests and to request clarification.
- Avoid unsupported warranties, liability caps, governing-law clauses, arbitration terms, or cancellation promises.

## User experience

### Global footer

Add one shared root-layout footer with links to all four current policies. It appears on public, account, cart, checkout confirmation, order lookup, and admin pages. Links have visible keyboard focus and work without client JavaScript.

The About page's existing `footer#about-page-end` becomes a non-footer closing section/sentinel so its navigation observer keeps the same target while the document has only one global footer.

### Policy routes

Provide server-rendered routes:

- current canonical: `/policies/[policyKey]`;
- immutable archive: `/policies/[policyKey]/[version]`.

Current routes render the active approved version. Archived routes render the exact committed version and digest recorded at checkout. Unknown keys/versions return framework 404. Every page has unique metadata, one `h1`, version/effective date, semantic headings, readable measure, and related-policy links. `/policies/*` is explicitly excluded from Clerk middleware so authentication outages do not block access. Pages and the global footer remain readable with JavaScript disabled.

Draft versions are preview-only, visibly marked as draft, and are not reachable as the production current policy until their approval record validates.

### Cart and checkout

Fetch the authoritative bundle before enabling checkout submission. Present concise shipping/privacy notices and one native, initially unchecked checkbox with the versioned statement: agreement to Terms, acknowledgment of Returns and Personalized Goods, and presentation of Shipping/Privacy notices. Each policy name links to the exact versioned page; bundle version/effective date is visible.

Once the bundle loads, the primary button remains enabled so keyboard and assistive-technology users can attempt submission. Missing assent prevents the request, renders/announces an associated error, and focuses the checkbox. Bundle load failure disables only checkout submission, provides retry, and leaves cart editing available.

The request sends the current bundle version plus explicit `termsAgreed: true` and `returnsAcknowledged: true`. The backend resolves all document and statement versions/digests; it does not trust client-provided metadata.

### Confirmation and order lookup

Both surfaces show `Policies for this order` when a stored snapshot exists. Links target exact archived versions. Historical orders with no snapshot show current policy links under `Current store policies` and explicitly do not imply prior acceptance.

The exact nullable customer DTO returned by checkout status, guest lookup, and account history is:

```ts
type CustomerPolicySnapshot = null | {
  schemaVersion: 1;
  bundleVersion: string;
  effectiveDate: string;
  statementSubmittedAt: string;
  checkoutStatement: { version: string; digest: string };
  documents: Array<{
    key: "shipping" | "returns" | "privacy" | "terms";
    role: "agreement" | "acknowledgment" | "notice";
    version: string;
    digest: string;
    path: string;
  }>;
};
```

Parsers reject malformed snapshots instead of partially rendering them. A null snapshot invokes only the historical-order fallback.

## Backend contract

### Public bundle endpoint

Add `GET /payments/checkout-policy` returning public metadata, roles, exact versioned paths, and checkout-statement version/digest. It includes no prose, secrets, or customer data. It returns an ETag derived from canonical metadata and `Cache-Control: public, max-age=0, must-revalidate` so rolling releases are deterministic.

### Checkout request and validation

Extend `POST /payments/checkout-sessions` with:

```json
{
  "policyAssertion": {
    "bundleVersion": "2026-11-03.1",
    "termsAgreed": true,
    "returnsAcknowledged": true
  }
}
```

Malformed/missing/false assertions return `400 POLICY_ASSERTION_REQUIRED`. A version that is not current for a not-yet-materialized cart returns `409 POLICY_VERSION_STALE` with current public metadata. Neither case creates an order nor calls Stripe.

After `POLICY_VERSION_STALE`, the client performs a cache-bypassing bundle refresh, clears the checkbox, and cannot resubmit until the refresh succeeds and the customer asserts the new statement.

The backend can prove only that a current explicit assertion was submitted by the authenticated user or guest-cart session; it does not claim proof that a human physically clicked a checkbox.

### Idempotency and provider sessions

Validate assertion structure at the request boundary. Inside the existing cart-lock transaction:

- A new checkout validates the requested bundle as current, resolves the server-owned canonical snapshot, creates the order, and inserts acceptance evidence atomically.
- A duplicate request for the same cart returns the existing order and stored snapshot.
- An existing order with a reusable Stripe session retains its immutable snapshot and remains resumable under that snapshot. A policy release alone never retires an order or Stripe session.
- An existing materialized order without a provider session retains its recorded snapshot for provider retry.
- Replacement occurs only after Stripe confirms the session is expired/unusable through the existing terminal-session recovery flow; the replacement checkout requires the then-current assertion and receives a new snapshot.
- A pre-migration open order with no snapshot is never described as agreed, acknowledged, or accepted. Before enforcement activates, a deployment preflight inventories every such order, asks Stripe to expire each open legacy Checkout Session, confirms the provider session is expired, and retires it through the existing terminal-session workflow. Enforcement activation fails while any payable legacy session without evidence remains. A replacement requires the current assertion and receives a new snapshot. Legacy sessions completed before the cutoff retain null evidence and are shown only the historical-order fallback.

`statement_submitted_at` is generated by PostgreSQL, never accepted from the client.

## Persistence and immutability

Create append-only `order_policy_assertions` rather than mutable columns on `orders`:

- `order_id uuid primary key references orders(id)`;
- `schema_version smallint` fixed to `1`;
- bounded, non-empty `bundle_version` and `effective_date`;
- bounded checkout-statement version and SHA-256 digest;
- `documents jsonb` with ordered key/role/version/digest/path records;
- `assertions jsonb` containing only the required asserted keys;
- `statement_submitted_at timestamptz not null default clock_timestamp()`.

The migration creates the new table without rewriting historical orders. Constraints require object/array types, bounded version values, 64-character lowercase hexadecimal digests, exactly four unique document keys with expected roles, and exactly the required assertion keys. A database trigger rejects update and delete so evidence is write-once. Order deletion is restricted rather than cascading evidence. API and customer-facing language describes only Terms as agreed, Returns as acknowledged, and Shipping/Privacy as presented notices; it never describes notice documents as accepted or agreed.

Tests apply the migration with historical orders present; reject partial/malformed snapshots; and reject later update/delete attempts.

## Authorization and exposure

- Checkout status exposes the snapshot only after the existing authenticated-user or guest-cart ownership check for the Stripe session succeeds.
- Guest order lookup exposes it only after the public order number plus normalized email/phone matches the order.
- Account history exposes it only for orders selected by the authenticated Clerk subject.
- Negative tests cover wrong guest session, wrong contact, different authenticated user, and unknown order.

No route exposes policy evidence by order ID alone.

## Observability

Emit bounded events:

- `checkout.policy.bundle_read`;
- `checkout.policy.rejected`;
- `checkout.policy.persisted`;
- `checkout.policy.existing_order_reused`.

Fields may include result code, requested/current/stored bundle version, auth mode, and order ID where available. Logs never include policy prose/digests, contact data, checkbox labels, uploaded content, or asset identifiers.

## Accessibility, metadata, and security

- Semantic landmarks/headings, sufficient contrast, visible focus, and readable line length.
- Linked text names each policy; no ambiguous `learn more` links or forced new tabs.
- Native checkbox with label and error description; keyboard-only error focus is tested.
- No policy block obscures the checkout CTA at 320px or supported mobile/desktop widths.
- Backend assertion validation is authoritative and bound to the resolved cart owner, while making no claim about physical user interaction.
- Policy evidence contains no secrets, contact data, IP addresses, prose, or asset details.

## Testing

### Frontend unit/integration

- Generated manifest completeness, exact metadata/digest parity, unique paths, versions, roles, and approval state.
- Global footer links and conversion of the About closing footer/sentinel.
- Current and archived pages render exact title/version/effective date/digest and related links; unknown key/version is 404.
- Policy routes are excluded from authentication middleware.
- Cart bundle loading, keyboard-only assertion validation/focus, request payload, stale refresh/re-assertion, and load-failure retry.
- Confirmation/order lookup distinguish a valid recorded snapshot from null historical evidence and reject malformed DTOs.

### Backend unit/integration

- Bundle schema, ETag, cache headers, and exact generated metadata parity.
- Missing/false assertion, malformed version, and stale-version errors.
- No order/Stripe call on policy errors.
- Transactional insert with database-generated time; append-only trigger/constraints.
- Same-order idempotency, policy release with reusable provider session, provider retry, and terminal replacement semantics.
- Legacy-session preflight, provider-confirmed expiration, enforcement refusal while a payable session lacks evidence, historical null evidence, and bounded privacy-safe logs.
- Publication validation rejects an approval record with an effective date before owner approval or production activation.
- Positive and negative authorization tests for every exposing route.

### End to end

- Navigate all footer links at 320px, mobile, and desktop widths with no overflow/overlap.
- Raw server-rendered footer/policy content remains readable with JavaScript disabled and no Clerk dependency.
- Guest and authenticated checkout initiation require the explicit statement.
- Stale bundle forces refresh and re-assertion.
- Confirmation and guest/account order views show exact archived links for recorded evidence and neutral current links for historical orders.

## Delivery slices

1. Append-only source/archive, deterministic generator, current/archive policy pages, global footer, metadata, middleware exclusion, and route/link tests.
2. Backend bundle endpoint, migration, assertion validation/persistence, idempotency/provider semantics, authorized response DTOs, observability, and backend tests.
3. Cart assertion UX, stale refresh, confirmation/order lookup rendering, frontend integration and E2E coverage.
4. Explicit owner-copy approval record and production publication gate.

## Out of scope

- Policy CMS/admin editor.
- Automated asset/contact retention or deletion. This gap must be described truthfully, not promised away.
- Cookie consent, marketing consent, SMS consent, data-subject automation, or jurisdiction-specific clauses.
- Invented support channels, return windows, carrier guarantees, or legal assertions.
- Retroactive acceptance claims for historical orders.

## Definition of done

- All issue acceptance criteria are implemented and tested.
- Generator check, backend/client builds, unit/integration tests, and targeted E2E tests pass.
- Migration applies with historical data and database integration coverage passes in the isolated test database.
- Final rendered copy is reviewed in the PR.
- Production publication and issue closure occur only after the explicit owner approval record matches the released versions and digests.
