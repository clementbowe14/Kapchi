# Exhibit A: Kapchi Software Features and Delivery Schedule

**Contract attachment type:** Software feature schedule / statement-of-work exhibit  
**Application:** Kapchi Store  
**Repository:** `clementbowe14/Kapchi`  
**Delivered baseline:** `main` at commit `97412a3`  
**Status date:** November 15, 2026  
**Client:** `[CLIENT LEGAL NAME]`  
**Developer:** `[DEVELOPER LEGAL NAME]`  
**Effective date:** `[EFFECTIVE DATE]`

> This exhibit describes product scope and acceptance boundaries. It is not a
> substitute for legal advice or for the agreement's payment, ownership,
> warranty, indemnity, privacy, support, termination, or governing-law terms.
> Counsel should review the completed agreement before signature.

## 1. Purpose and Interpretation

This exhibit may be attached to a master services agreement, independent
contractor agreement, software development agreement, or statement of work. It
identifies:

1. features implemented in the delivered baseline;
2. implemented features that remain subject to a release or owner-approval
   condition;
3. work currently in review; and
4. planned features that are not delivered and are excluded from the current
   scope unless expressly added by written change order.

Repository code, migrations, automated tests, and referenced pull requests are
the technical evidence for this schedule. Marketing descriptions, prototypes,
issue titles, screenshots, and planned-feature descriptions do not expand the
delivered scope unless incorporated into a signed change order.

## 2. Status Definitions

| Status | Contract meaning |
| --- | --- |
| **Delivered** | Implemented in the identified `main` baseline and available for acceptance testing, subject to configured third-party services. |
| **Implemented; release-gated** | Code exists in `main`, but production use is conditioned on owner approval, provider configuration, migration, operational evidence, or another stated release prerequisite. |
| **In review** | Implemented on a branch or pull request but not part of the delivered baseline. It becomes Delivered only after approval and merge. |
| **Partially implemented** | A bounded portion exists, but the complete feature described by the related issue or roadmap item is not delivered. |
| **Planned** | Proposed or tracked work that is not part of the delivered baseline and requires separate authorization, schedule, and acceptance. |

## 3. Delivered Customer-Facing Features

| ID | Feature | Delivered behavior | Acceptance standard |
| --- | --- | --- | --- |
| C-01 | Responsive storefront shell | Responsive navigation, mobile menu, authentication controls, cart access, footer links, loading states, and customer-safe error states. | Public pages render on supported desktop/mobile layouts and primary navigation remains keyboard operable. |
| C-02 | Homepage and hero carousel | Kapchi homepage with branded hero carousel, Indigenous/Andean stole messaging, responsive imagery, calls to action, and catalog content below the hero. | Slides render without layout overlap and navigation controls change the active slide. |
| C-03 | About Kapchi page | About page presenting Kapchi's purpose and cultural/product story with responsive navigation and Peru imagery. | Page is reachable from the storefront and renders supplied content responsively. |
| C-04 | Graduation-stole catalog | Public listing retrieval, listing cards, fabric-aware imagery, low-stock presentation, and listing detail routes. | Active listings load from the API; unavailable catalog states produce a bounded retry/error experience. |
| C-05 | Fabric selection | Customers can view fabric options and fabric images; selecting a fabric updates the product image and preserves the chosen fabric in cart/order snapshots. | Selected fabric and its customer-safe name/image remain consistent through cart and order creation; internal color SKU/IDs are not shown in customer order lookup. |
| C-06 | Customization tiers | Supports no customization, short text, long text, long text plus image, and long text plus image plus trim. | The UI exposes only fields included in the paid tier and rejects unsupported image/trim data. |
| C-07 | Text, font, image, and trim configuration | Text entry, font selection, private image upload, trim option/size selection, customization notice, validation, and production estimate presentation. | Valid selections persist into cart/order snapshots; out-of-tier or invalid values fail with actionable validation. |
| C-08 | Private customer artwork upload | Provider-neutral asset intent/completion flow using Vercel Blob transport, image type/size restrictions, signed callbacks, ownership checks, and private metadata storage. | Authorized uploads complete and attach to the intended cart item; altered, replayed, unauthorized, or invalid uploads are rejected. |
| C-09 | Guest and authenticated carts | Guest and Clerk-authenticated carts, add-to-cart, quantity update, item removal, validation status, revision handling, and idempotent mutations. | Cart totals and item counts reflect durable cart state after add, update, remove, refresh, and duplicate request handling. |
| C-10 | Guest-to-user cart claim | On authentication, eligible guest cart items merge into the user's cart without dropping customization, fabric, image, trim, quantity, pricing, or production metadata. | A successful claim preserves item data and does not create unauthorized cross-user ownership. |
| C-11 | Stripe Checkout | Backend-created Stripe Checkout Sessions, catalog price validation, trusted totals, success/cancel URLs, policy snapshot handling, retry/reconciliation behavior, and signed Stripe webhook processing. | A valid cart creates one reusable test/live-mode-appropriate session; duplicate requests/webhooks do not create duplicate paid effects. |
| C-12 | Checkout confirmation | Customer confirmation page polls the backend for durable checkout status and displays a customer-safe public order number and result state. | Paid, pending, failed, expired, and unavailable outcomes display bounded states without exposing provider secrets. |
| C-13 | Customer order lookup | Lookup by public order number and matching customer contact information, with item/customization summaries, policy links, payment/fulfillment state, and tracking when available. | Valid matching information returns the customer-safe order view; mismatched information does not disclose the order. |
| C-14 | Authentication and account surfaces | Clerk sign-in, sign-up, profile, authenticated navigation, JWT verification, issuer/audience/authorized-party validation, and account-aware cart behavior. | Valid configured Clerk sessions authenticate; invalid issuer, audience, signature, or authorized-party claims are denied. |
| C-15 | Production and delivery estimates | Listing/cart data includes production estimates and rush/priority metadata where configured, distinct from carrier transit information. | Estimates derive from configured rules and are snapshotted for purchased items rather than silently changing with later catalog edits. |

## 4. Delivered Administrative and Operations Features

| ID | Feature | Delivered behavior | Acceptance standard |
| --- | --- | --- | --- |
| A-01 | Server-side admin authorization | Clerk-derived admin roles/capabilities, active-admin verification, route-level permissions, audit attribution, and denial of client-supplied role claims. | Unauthorized and inactive users cannot access protected APIs or perform mutations. |
| A-02 | Admin orders dashboard | Protected order list with search, pagination, status/payment/fulfillment filters, refunded-only filter, production-priority data, loading states, and empty/error states. | Results reconcile with backend filters and remain bounded by pagination. |
| A-03 | Admin order detail | Protected order detail including customer/shipping snapshots, items, customization/production data, payment state, fulfillment, shipment, policy evidence, and chronological history. | An authorized admin can load one order without exposing unrelated customer orders. |
| A-04 | Guarded order mutations | Intent-specific, revision-aware, idempotent actions for starting production and marking an order ready to ship. | Valid state transitions succeed once; stale revisions, duplicate intents, and forbidden transitions fail safely. |
| A-05 | Shipment confirmation and tracking | Authorized shipment confirmation with carrier/tracking information and customer-safe tracking exposure. | Confirmed tracking appears in customer lookup; order history records the mutation without exposing private provider data. |
| A-06 | Shipping-address correction | Guarded correction of eligible order shipping addresses before irreversible shipping work. | The correction requires admin capability and valid order state, and creates auditable history. |
| A-07 | Private artwork administration | Authorized metadata and streamed-content access to paid, attached, private customization artwork with binding, quarantine, deletion, and reference-integrity checks. | Anonymous/non-admin access is denied; admins cannot retrieve unpaid, mismatched, deleted, quarantined, or unselected artwork. |
| A-08 | Stripe refund operations | Full/partial refund requests, minor-unit validation, idempotency keys, durable refund ledger, provider dispatch, webhook/reconciliation handling, leases, retry bounds, and summary/status APIs. | Duplicate or uncertain requests reconcile to one durable operation; failed/pending/succeeded states remain explicit. |
| A-09 | Pirate Ship export workflow | Admin shipping candidate selection, address readiness checks, CSV export batches, secure download, cancellation/expiry/purge actions, active-membership protection, and shipping-address correction integration. | Exported batches contain eligible selected orders only; irreversible label purchase remains outside Kapchi and under human control. |
| A-10 | Shipping export user interface | Protected admin page for selecting candidates, creating/downloading batches, reviewing failures, cancelling batches, and correcting blocked addresses. | UI reflects backend batch state and does not mark orders shipped merely because a file was exported. |
| A-11 | Customer messaging backend | Order-linked conversations, replies, internal notes, conversation state, transactional notification intents, signed provider webhook intake, delivery jobs, retries, and idempotent processing. | Messages/notes remain associated with the order; invalid signatures and duplicate callbacks are safely handled. |
| A-12 | Transactional order notifications | Durable order-confirmation and fulfillment/refund notification scheduling with contact/consent checks and retryable delivery processing. | Eligible lifecycle events create one durable notification intent; missing contact or consent is reported without fabricating delivery. |
| A-13 | Fabric inventory backend | Shared fabric records, stock adjustments, reservation/cart holds, order conversion, availability calculation, reconciliation, and admin inventory APIs. | Concurrent reservations cannot oversell durable inventory and adjustments are auditable. |
| A-14 | Sales analytics backend baseline | Bounded currency/date/timezone reporting for implemented gross-sales, paid-order, unit, average-order, bucket, best-seller, payment, and fulfillment metrics, with unsupported metrics represented explicitly. | Queries use minor units, do not sum currencies, and return explicit capability limitations rather than fabricated totals. |

## 5. Delivered Platform, Security, and Quality Features

| ID | Feature | Delivered behavior | Acceptance standard |
| --- | --- | --- | --- |
| P-01 | Next.js and Fastify architecture | Separate Next.js storefront and Fastify API projects designed for separate Vercel deployments and same-site custom domains. | Each project builds independently and the storefront uses the configured API origin. |
| P-02 | PostgreSQL persistence | Migrations and durable models for users/customers, listings/customizations, fabrics, carts, orders/items, events, messages, assets, inventory, fulfillment, shipments, refunds, policy assertions, and notification intents. | Migration apply/check commands complete without drift and preserve historical order snapshots. |
| P-03 | Migration safety | Serialized migrations, checksums, history/status commands, direct migration URL support, protected production workflow, and blocked unsafe reset behavior. | Production checks reject pending, mismatched, or unchecksummed migration state. |
| P-04 | Database connection controls | Pool sizing, timeouts, TLS mode, deployment connection budgeting, and startup validation. | Invalid or over-budget pool settings fail before traffic is accepted. |
| P-05 | Redis integration | TLS-capable Redis connection for guest sessions, cart/session state, rate/operation state, distributed cron locks, TTL conventions, and explicit failure behavior. | Backend startup/readiness reports Redis failure and durable commerce records remain in PostgreSQL. |
| P-06 | Vercel Blob integration | Private customer artwork storage transport, callback signing/key rotation, bounded private reads, and production token restrictions. | Production rejects legacy callback authentication and unauthorized/private reads. |
| P-07 | Structured observability | Request IDs, lifecycle events, duration/status/error codes, domain events, safe error details, and logging redaction for secrets and sensitive payloads. | Logs correlate operations without recording tokens, raw webhook payloads, addresses, or customization text. |
| P-08 | Health and readiness | Public health plus dependency-aware readiness for database, Redis, migrations, and private assets. | Unready dependencies produce a bounded non-ready response suitable for traffic gating. |
| P-09 | Scheduled operations | Authenticated, Redis-locked scheduled routes for messages, refunds, inventory, maintenance, and health. | Duplicate scheduler delivery does not run the same bounded operation concurrently. |
| P-10 | Safe local fixtures | Deterministic local/test fixtures, explicit database marker/token, ownership records, advisory locking, collision/drift checks, fake customer data, and verification. | Fixture commands refuse production, remote, unmarked, or unsafe databases. |
| P-11 | Test coverage | Vitest unit/integration suites, React component tests, Playwright public/admin/real configurations, database integration tests, and script-level contract tests. | Applicable suites pass for the delivered baseline; provider-hosted checks remain separately evidenced. |
| P-12 | CI and secret scanning | Production-readiness workflow, Gitleaks/GitGuardian integration, example-environment validation, policy artifact checks, and Vercel preview checks. | Tracked examples contain no real credentials and secret-sensitive changes are scanned. |
| P-13 | Production operations controls | Environment ownership inventory, migration workflow, provider canary contracts, alert definitions, backup/restore drill tooling, rollback runbook, and launch-record validation. | Repository controls validate; external production evidence remains subject to Section 6. |
| P-14 | Policy versioning mechanism | Versioned policy archive, generated policy artifacts, checkout/order policy assertions, publication validator, and customer policy routes/links. | Draft policy bundles cannot be published without an explicit owner approval record. |

## 6. Implemented but Release-Gated or Partially Implemented Features

| ID | Status | Feature | Remaining condition / limitation |
| --- | --- | --- | --- |
| G-01 | Implemented; release-gated | Shipping, returns, privacy, and terms pages (#117) | Store owner or qualified counsel must approve the policy bundle; the publication guard must pass and legacy sessions lacking policy evidence must be resolved before production publication. |
| G-02 | Implemented; release-gated | Production deployment/rollback controls (#114) | Repository runbooks and validators exist, but operators must configure production providers, backups, alerts, domains, secrets, and immutable launch evidence and complete the go/no-go process. |
| G-03 | Partially implemented | Staging release gate (#115) | The approved specification, scenario registry, validator, release identity endpoint, and staging Playwright foundation are in PR #136, not `main`; provider-specific deployment, disposable database provisioning, complete staging scenarios, evidence capture, cleanup, and final launch-record integration remain. |
| G-04 | Partially implemented | Persistence/admin fixtures (#85) | Safe local fixtures cover implemented admin workflows; disposable hosted staging fixtures and future promotion/catalog-management fixture coverage remain. |
| G-05 | Partially implemented | Dashboard analytics (#104) | Baseline aggregates exist. Complete net-sales/refund/cohort comparison semantics and any remaining design drill-down alignment remain governed by #104. |
| G-06 | Partially implemented | Full admin dashboard program (#99) | Orders, fulfillment, assets, refunds, messaging backend, shipping exports, inventory backend, and analytics foundations exist; remaining UI/catalog/promotion work is listed in Section 7. |

## 7. Planned Features Excluded from Current Delivered Scope

Unless a signed change order identifies an item below as included, each item is
**Planned** and is not a present delivery obligation.

| ID | Planned feature | Proposed scope | Primary dependency / issue |
| --- | --- | --- | --- |
| F-01 | Product archive backend | Authorized soft archive/removal API; hide archived products from new shopping while preserving historical orders. | #10 |
| F-02 | Product archive admin UI | Confirmation, success/error feedback, archive status, and removal from public listings. | #18; depends on F-01 |
| F-03 | Admin product customization controls | Create/edit controls for enabling no customization, short/long text, image, trim, fonts, and related public configuration. | #17 |
| F-04 | Automatic Stripe catalog creation | Create/reconcile Stripe Product and immutable Price objects when admins create or reprice products; idempotent retries and metadata mapping. | #31 |
| F-05 | Admin fabric inventory UI | Searchable stock table, adjustment controls, shared-fabric usage, reservation/sold counts, and status management. | #33; backend inventory already delivered |
| F-06 | Admin customer messaging UI | Compose replies from order detail, show preferred contact method and history, display delivery errors, and prevent sends without usable contact data. | #20; messaging backend already delivered |
| F-07 | Promotions | Durable percentage/fixed promotions, schedules, eligibility, usage limits, atomic redemption holds, checkout enforcement, admin APIs/UI, and analytics integration. | #102 |
| F-08 | Completed analytics program | Net sales/refund reporting, previous-period comparisons, customer cohorts, complete drill-down reconciliation, and documented cache/index behavior. | #104; depends on refund/customer identity contracts |
| F-09 | Pirate Ship AI assistant | Human-supervised browser assistance for spreadsheet upload, field mapping, address/rate review, label preparation, and tracking return. No automated credential bypass or unapproved purchase. | #30; export workflow already delivered |
| F-10 | Hosted staging fixtures | Disposable, run-owned, non-production database/provider fixtures with identity attestation and bounded cleanup. | #85 and #115 |
| F-11 | Full staging purchase-to-fulfillment gate | Automated guest/authenticated checkout, all customization tiers, Blob, Stripe, fulfillment, tracking, refund, logs, manual provider evidence, cleanup, and immutable GO/NO-GO artifact. | #115; PR #136 is foundational only |
| F-12 | Production launch execution | Provider configuration, production migrations, domain/CORS/auth verification, backup/restore drill, alerts, rollback rehearsal, observation window, and signed launch record. | #114 |
| F-13 | Policy publication | Owner/counsel approval record, release of approved policy bundle, legacy checkout remediation, and production verification. | #117 |
| F-14 | Remaining dashboard alignment | Complete real-data Overview, Inventory, Promotions, and Messages experiences and remove remaining prototype/simulated dependencies. | #99; coordinated by F-05 through F-08 |

## 8. Third-Party Services and Client Responsibilities

The application integrates with services that are not delivered or controlled by
the Developer. Unless the main agreement states otherwise, the Client is
responsible for obtaining, paying for, maintaining, and lawfully configuring:

- Vercel projects, domains, deployment plan, Blob storage, and runtime variables;
- a managed PostgreSQL database and backup/restore capability;
- a managed TLS Redis instance;
- Clerk production and test applications, roles, domains, and webhook endpoint;
- Stripe production/test accounts, products/prices, webhook endpoint, and payout
  or tax configuration;
- the selected email/SMS delivery provider and approved sender identities;
- Pirate Ship account access and final human approval of label purchases; and
- approved policy text, cultural/brand copy, product images, prices, fabric data,
  inventory, fulfillment rules, and customer-support procedures.

Third-party downtime, pricing, API changes, account suspension, rate limits,
verification delays, payment declines, carrier performance, and provider data
retention are not defects in the delivered software unless caused by the
Developer's failure to implement the agreed integration contract.

## 9. Acceptance Procedure

1. Developer identifies the release commit and supplies deployment or local test
   instructions for the applicable Delivered items.
2. Client has `[10]` business days after delivery to test the applicable
   acceptance standards and provide written, reproducible rejection details.
3. Rejection must identify the feature ID, expected behavior, actual behavior,
   environment, and reasonable reproduction steps. Preferences or new
   requirements are change requests rather than defects.
4. Developer will correct reproducible material nonconformities within the
   warranty/correction period stated in the main agreement and resubmit them.
5. A feature is accepted upon written acceptance, production use, or expiration
   of the review period without a valid rejection, subject to the main agreement.
6. Release-gated items are not accepted for production merely because repository
   tests pass; their stated owner/provider/operational conditions must also pass.

## 10. General Nonfunctional Acceptance Standards

Delivered features are subject to the following standards where applicable:

- server-side authorization for protected data and mutations;
- validation of untrusted request data and provider callbacks;
- no committed production credentials or disclosure of server secrets to the
  browser;
- integer minor-unit monetary calculations and currency isolation;
- idempotency or durable reconciliation for retryable commerce mutations;
- customer-safe errors that do not expose internal provider/catalog identifiers;
- responsive and keyboard-operable primary customer/admin workflows;
- structured correlation/error logging with sensitive-field redaction;
- database migrations and rollback/roll-forward procedures appropriate to the
  released schema; and
- automated tests proportionate to the changed feature's risk.

No software is guaranteed to be uninterrupted or defect-free. Performance,
availability, recovery-time, support-response, and security-assurance service
levels apply only if separately stated in the main agreement.

## 11. Exclusions

Unless added by written change order, the current scope excludes:

- native iOS or Android applications;
- a general-purpose content-management system;
- automatic creation of legal advice or final policy language;
- automated tax registration, tax advice, customs compliance, or accounting;
- automatic Pirate Ship label purchase or bypass of login, CAPTCHA, MFA, or
  payment confirmation;
- promotion features described in F-07;
- live production data migration from an unidentified legacy system;
- guarantees concerning third-party approval, uptime, deliverability, payment
  authorization, or carrier delivery;
- 24/7 operations, incident response, or ongoing maintenance unless separately
  purchased; and
- any open GitHub issue or prototype not expressly listed as Delivered in this
  exhibit.

## 12. Change Control

Any material addition or change to features, acceptance standards, third-party
providers, data migration, production topology, compliance requirements, or
delivery dates requires a written change order signed by both parties. A change
order should identify affected feature IDs, price, schedule, assumptions,
acceptance criteria, and any change to support or operating responsibility.

## 13. Sign-Off

By signing below, the parties acknowledge that Sections 3 through 5 describe the
delivered technical baseline, Section 6 describes conditional or incomplete
capabilities, and Section 7 describes planned work excluded from the current
delivery unless separately authorized.

| Client | Developer |
| --- | --- |
| Name: `[NAME]` | Name: `[NAME]` |
| Title: `[TITLE]` | Title: `[TITLE]` |
| Signature: ____________________ | Signature: ____________________ |
| Date: _________________________ | Date: _________________________ |

## Appendix A: Traceability References

- Delivered baseline: `main` commit `97412a3`
- Staging release-gate foundation: PR #136, branch
  `codex/issue-115-staging-release-gate`
- Customer commerce: issues #6, #7, #13, #14, #15, #16, #23, #24, #25, #61,
  #91, #93, #94, and #98
- Admin/order operations: issues #11, #12, #19, #21, #22, #29, #32, #100,
  #101, #103, #116, and #122
- Persistence/infrastructure: issues #26, #27, #34 through #55 and #85
- Planned/open roadmap: issues #10, #17, #18, #20, #30, #31, #33, #99, #102,
  #104, #114, #115, and #117
