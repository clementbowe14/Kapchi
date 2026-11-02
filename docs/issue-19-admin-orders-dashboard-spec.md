# Issue #19: Admin Ongoing Orders Dashboard

## Status

Approved for implementation after three independent reviews covering
operational UX/accessibility, frontend/API architecture, and test/security
behavior. All three reviewers returned `VERDICT: APPROVE` on this revision.

## Problem

Kapchi administrators have protected backend endpoints for searching and
inspecting orders, but no frontend workflow for using them. The dashboard must
make ongoing fulfillment work easy to scan without weakening the backend's
authorization boundary or rebuilding historical order data from the current
catalog.

## Goals

1. Give a signed-in, authorized administrator a compact view of ongoing orders.
2. Show customer contact snapshots when available, order/payment/fulfillment
   status, purchased quantities, and order totals in minor-unit-safe formatting.
3. Let an administrator filter by order status (satisfying the issue's
   disjunctive "filter or sort by order status" criterion) and additionally
   sort the queue oldest/newest first.
4. Let an administrator open a durable detail page that shows purchased items
   and the exact stored listing, fabric, and customization selections.
5. Provide clear loading, empty, unauthorized, forbidden, unavailable, and
   unexpected-error states with a deliberate retry path.
6. Cover pure presentation logic, browser/API integration, and the protected
   user journey with unit, integration, and end-to-end tests.

## Non-goals

- Changing order, payment, fulfillment, shipment, refund, or inventory state.
- Editing customer, shipping, or customization data.
- Displaying private customization image content. Issue #101 owns secure asset
  delivery; this feature may show that an asset was selected or unavailable.
- Reconstructing missing historical snapshots from live listing or fabric data.
- Adding a public admin demo or an authorization bypass for tests.
- Replacing backend authorization with Clerk UI state or client-side role checks.

## Routes and authorization

### `/admin/orders`

The canonical list route. It renders a client boundary that waits for Clerk,
requires a signed-in session, requests a fresh bearer token, and calls
`GET /admin/orders`. The initial request uses:

- `lifecycle=ongoing`
- `limit=25`
- `sort=created_desc`
- an optional exact `orderStatus`

The order-status selector is restricted to the backend's ongoing set:
`pending_payment`, `paid`, `in_production`, `ready_to_ship`, `shipped`, and
`refunded`. It never submits `completed` or `cancelled`, because an explicit
`orderStatus` takes precedence over `lifecycle=ongoing` in the backend.

The backend remains authoritative. A signed-in user who lacks `orders:read`
sees a forbidden state; the UI never infers authorization from user metadata.

### `/admin/orders/[orderId]`

The canonical, refreshable detail route. It validates that an identifier is
present, obtains the Clerk token, and calls `GET /admin/orders/:orderId`.
The page includes a back link to the orders dashboard. It does not call the
timeline or mutation endpoints in this issue.

### Authentication and error mapping

- Clerk loading: stable dashboard shell with an announced loading status.
- Signed out or missing token: sign-in-required state with a link to `/sign-in`.
- API 401: attempt exactly one forced Clerk token refresh. If the replay is also
  unauthorized or no token is returned, clear protected data and show the
  session-invalid state with a sign-in action.
- API 403: insufficient-permission state without exposing order data.
- API 404 on detail: order-not-found state with a return link.
- API 503: temporary-unavailable state, honoring `Retry-After` in the message
  when it is a safe integer, plus an explicit Retry button.
- Other failures or malformed responses: generic error state and Retry button.
- Abort errors from navigation/filter replacement are ignored, not shown.

An account change, sign-out, missing token, 401, or 403 aborts active requests,
increments the request sequence, and immediately removes all protected order
data from memory and the DOM. Retaining last-known rows is permitted only for a
transient network failure or 503 under the same authenticated user ID.

No customer contact, address, customization content, bearer token, or response
body is written to browser logs. User-facing errors come from a client-owned
status/code allowlist; arbitrary backend messages are never rendered.

## API client and data model

Create a feature-local `client/features/admin-orders` boundary:

- `types.ts`: frontend representations matching the documented backend contract.
- `api.ts`: query serialization, authenticated GET requests, response/error
  handling, UUID validation for detail IDs, and abort support.
- `format.ts`: money/date/status labels and safe snapshot field extraction.

API calls use `buildApiUrl`, `cache: "no-store"`, `Accept: application/json`, and
`Authorization: Bearer <token>`. Search values use `URLSearchParams`; dynamic
path segments are UUID-validated and encoded. Requests are not automatically
retried except for the single forced-token-refresh replay after a 401; an
administrator explicitly retries other failures so a service outage cannot
create a request loop. The API error object carries only status, an allowlisted
backend code, client-owned message, and optional retry delay.

Money is formatted from integer `amountMinor` values and each value's own
currency. Values from different currencies are never combined. Unknown or
invalid currency/date data falls back to a neutral `Not available` label rather
than crashing the dashboard.

The response parser validates the fields required to render a list/detail. A
malformed success response is treated as an error rather than partially
rendering misleading operational data.

## Component design

This is an operational surface: compact, restrained, and optimized for repeated
scanning. It uses the existing Kapchi neutral/gold palette but avoids marketing
hero treatment, decorative cards, and oversized type.

### Shared shell

`AdminOrdersShell`

- Full-width light workspace with a constrained inner width.
- Compact heading, supporting copy, and order count/loading context.
- Uses a semantic `main`; status changes use `role="status"` or `role="alert"`.
- The existing global navbar remains visible. No admin navigation expansion is
  included until there is a broader admin information architecture.
- Signed-in users receive an `Admin orders` entry in the existing desktop
  account cluster and mobile account panel. This is a discoverability link, not
  an authorization decision: non-admin users are still denied by Fastify and
  see the dedicated forbidden state.
- Both admin routes export `robots: { index: false, follow: false }` metadata.

### List page

`AdminOrdersDashboard`

- Owns authenticated request state, filters, cursor pagination, and stale-request
  cancellation.
- Keeps the last successful result visible while a filter refresh is pending
  for the same identity, but disables repeated submissions and announces the
  refresh.
- An identity-bound request fingerprint and sequence guard prevent a prior
  replacement or append request from updating state after filters change,
  authentication changes, navigation occurs, or a newer request completes.
- Applied filter and sort values live in the URL query string. Detail links carry
  a validated return query so browser Back and the explicit return link restore
  the manager's working context.

`AdminOrderFilters`

- A native status select with `All ongoing statuses` plus only the six
  non-completed/non-cancelled statuses documented above.
- A native sort select for `Newest first` and `Oldest first`.
- `Apply filters` and `Clear` commands. Filter changes do not fetch until Apply,
  preventing request-per-keystroke behavior and making the update predictable.
- Applying/clearing resets cursor pagination.

`AdminOrdersTable`

- Desktop table columns: order, customer, placed, items, total, order status,
  payment, fulfillment, and an open-detail link with an external-link icon.
- Customer cell prefers name, then email, then `Guest customer`; available email
  and phone appear as secondary text.
- `itemCount` describes distinct lines and `totalQuantity` describes units.
- Row links are keyboard reachable; the table has a descriptive caption.
- At narrow widths the same data becomes unframed stacked rows with explicit
  labels and a visible, 44px-tall `View order` link. Responsive variants use CSS
  display rules so only one representation is visible and focusable. Content is
  not forced into a horizontally scrolling table.

`OrderStatusBadge`

- Humanizes known enum values while preserving the raw value in an accessible
  label where needed.
- Color is supplementary; text always carries the status meaning.

`LoadMoreOrders`

- Shown only when `nextCursor` exists.
- Appends a page using the same filter/sort fingerprint.
- De-duplicates by order ID and replaces the earlier row with the later server
  version to tolerate a boundary record changing while an administrator pages.
- Failure to load another page preserves existing rows and shows an inline
  retry action.
- Success announces the number of rows appended.

### Detail page

`AdminOrderDetail`

- Summary band: public order number, created date, total, and the three statuses.
- Contact section: name, email, phone, preferred contact method; absent values
  are explicitly `Not provided`.
- Purchased items section: one `AdminOrderItemDetail` per stored line with
  quantity, unit price, total, listing title snapshot, fabric snapshot, and
  customization/production selections.
- Shipping section: recipient and a conservative formatted address from stored
  string fields only; no arbitrary object dump.

`AdminOrderItemDetail`

- Listing/fabric labels are extracted from a small allowlist of common snapshot
  keys (`title`, `name`, `label`, `color`) and otherwise shown as `Not stored`.
- Exact production text lines are displayed when availability is `present`.
- Font, placement, and trim are rendered from the normalized `production`
  fields using field-specific positive allowlists. Text always comes from
  `production.text.line1`/`line2`. The customization snapshot may contribute
  only explicitly approved display fields (`level`, `levelName`,
  `customizationType`, `type`), while listing/fabric snapshots use only the
  label keys named above. Unknown nested snapshot fields are never traversed or
  rendered, and all values render as React text rather than HTML.
- Every normalized production field is represented. Availability states remain
  distinct as `Present`, `Not selected`, and `Not stored`; an unknown structured
  value is shown as `Stored selection` rather than omitted or dumped.
- Image customization shows `Selected`, `Not selected`, or `Unavailable`; it
  does not expose asset IDs or fetch private content.
- Archived catalog references are identified without replacing snapshots.

## State behavior

1. Initial load uses skeleton rows with fixed dimensions to avoid layout shift.
2. Empty ongoing queue says `No ongoing orders` and retains filter controls.
3. Empty filtered result says `No orders match these filters` and offers Clear.
4. Transient same-identity refresh failure keeps prior rows, marks them with the
   exact previously applied filter fingerprint as last-known data, and offers
   Retry. Authorization/identity failure clears rows immediately. Initial
   failure renders the full error state.
5. Detail loading uses a fixed summary and item skeleton.
6. All async actions disable only the initiating control and remain keyboard
   operable after completion.

## Accessibility and responsive requirements

- One `h1` per route and ordered section headings.
- Every input has a persistent label; every icon-only control has an accessible
  name and tooltip.
- Focus indicators meet the existing gold focus treatment.
- Status is never encoded by color alone.
- Loading and error changes are announced without moving keyboard focus.
- At 320 CSS pixels, controls wrap, values break safely, and no text overlaps.
- Reduced-motion preferences are respected; this feature requires no animation.

## Testing strategy

### Unit tests (Vitest)

- Query serialization omits unset fields and preserves the documented enum.
- Minor-unit money and date formatting, including invalid input fallbacks.
- Status humanization.
- Snapshot extraction reads only positive-allowlist keys and handles nulls,
  arrays, malformed values, and unknown structured values safely.
- API response validation rejects malformed successful payloads.

### Integration tests (React Testing Library + Vitest)

- Signed-out, missing-token, 401, 403, 503, malformed-response, and retry states.
- One forced token refresh after 401 succeeds or fails without a retry loop.
- Identity switch, sign-out, token loss, 401, and 403 after a successful load
  clear protected rows and abort pending replacement/append requests.
- Authenticated list request includes bearer token and ongoing defaults.
- Order rows render customer fallback, quantities, money, and all statuses.
- Applying and clearing status/sort filters produces the expected query and
  ignores stale responses.
- Empty default and empty filtered states differ.
- Cursor pagination appends/de-duplicates rows and preserves rows on failure.
- Delayed append responses cannot land after filter changes, auth changes,
  navigation/unmount, or a newer append response.
- Detail request renders stored listing/fabric/customization values, redacts
  unsafe snapshot keys, does not expose asset IDs, and handles 404.

### End-to-end tests (Playwright)

- Add Playwright configuration and dedicated web-server commands. Ignore the
  local Clerk storage-state file and all Playwright artifacts.
- Include an always-running signed-out browser test proving the route does not
  request or expose order data without a session.
- The authenticated suite uses a real Clerk test-mode administrator session
  supplied through a local/CI storage-state secret; there is no application
  test bypass. Tracing, screenshots, video, and request logging are disabled for
  authenticated runs so cookies and tokens cannot enter artifacts.
- Deterministic browser-interaction tests may intercept Fastify responses, but
  at least one seeded smoke path must reach the real Fastify `GET /admin/orders`
  and `GET /admin/orders/:orderId` endpoints with that admin session. It verifies
  routing, authorization, and response compatibility end to end.
- Verify the default ongoing request, visible order/customer/status data,
  status/sort filtering, navigation to a detail URL, item customization display,
  browser back behavior, and a recoverable API failure.
- Run at desktop and mobile viewport sizes; assert no horizontal overflow on the
  mobile list and detail routes.

The authenticated desktop and mobile browser journeys, including the real-API
smoke path, must execute successfully before this feature meets its definition
of done. A missing Clerk fixture is a reported blocker, never a passing skip.

## Acceptance criteria mapping

| Issue criterion | Planned evidence |
| --- | --- |
| View ongoing orders | Default `lifecycle=ongoing` list and integration/E2E assertion |
| Customer name/contact | Customer table cell and detail contact section |
| Order status | Text status badge in list/detail |
| Items purchased | Quantity summary in list and stored lines in detail |
| Customization selections | Positive-allowlist historical/production rendering in detail |
| Filter/sort by status | Ongoing order-status filter plus creation-date sort assertions |
| Open detail view | Durable `/admin/orders/[orderId]` route |
| Empty/loading/API errors | Dedicated states with retry coverage |

## Definition of done

- All three design/spec reviewers explicitly approve the final revision.
- Client lint, type/build, unit, and integration suites pass.
- Playwright signed-out, authenticated desktop/mobile, and real-Fastify smoke
  tests all pass with the test-mode Clerk admin fixture.
- No backend contract or authorization behavior is weakened.
- Manual desktop/mobile inspection finds no overlap, overflow, or inaccessible
  control.
