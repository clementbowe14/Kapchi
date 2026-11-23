# Exhibit A: Kapchi Website Features

**Application:** Kapchi Store

**Document purpose:** Plain-language list of implemented and planned work

**Implemented-work reference:** `main` at commit `97412a3`

**Status date:** November 23, 2026

**Client:** `[CLIENT LEGAL NAME]`

**Developer:** `[DEVELOPER LEGAL NAME]`

**Effective date:** `[EFFECTIVE DATE]`

This document may be attached to a software development agreement or statement
of work. It explains what exists in the referenced source code, what still needs
preparation before launch, and what is only planned for the future. It is not a
standalone legal agreement and does not become binding unless the parties attach
it to, and sign, an agreement that identifies it.

The parties should complete the names, dates, payment terms, ownership terms,
support terms, and other legal terms in the main agreement. A lawyer should
review the final agreement before it is signed.

## Quick Summary

Kapchi's current source code allows customers to browse and customize graduation
stoles, upload artwork, use a shopping cart, pay through Stripe, receive an order
number, and track an order. Authorized store staff can review and filter orders,
move them through production, prepare Pirate Ship export files, and confirm
tracking. Secure server support exists for artwork access, refunds, messaging,
and inventory, but some of those staff screens and outside-service connections
are not finished. Final production setup and full pre-launch testing also remain.

## 1. How to Read This Document

| Status | Meaning |
| --- | --- |
| **Implemented in source code** | The feature exists in the identified source-code version. This does not mean it has been configured, deployed, accepted, or approved for production use. |
| **Implemented, launch setup required** | Most or all of the code exists, but approval, provider setup, scheduling, or final testing is still required. |
| **In review** | The work has been written but has not yet been approved and added to the main application. |
| **Partially completed** | Part of the feature works, but more work is required to provide the full feature. |
| **Planned** | The feature has not been completed. It is not included in the current delivery unless the parties approve it in writing. |

Throughout this document, "implemented" describes the source code only. It is
not a promise that the feature is live, fully configured, legally approved, or
accepted by the Client.

## 2. Features Available to Customers

The following customer features are **Implemented in source code**:

### Website and Product Browsing

- A responsive homepage that works on desktop and mobile devices.
- A Kapchi hero image carousel with cultural and product messaging.
- An About Kapchi page that explains the business and its purpose.
- Product listings shown on the homepage and on product pages.
- Product images, prices, available fabrics, and low-stock notices.
- Product images that change when a customer selects a different fabric.
- Navigation for the shop, cart, account, order tracking, policies, and About
  page.

### Graduation Stole Customization

Customers can choose from these options:

1. No customization.
2. Short text.
3. Long text.
4. Long text and an image.
5. Long text, an image, and trim.

The website also provides:

- text-entry fields;
- font choices;
- fabric choices and fabric images;
- image upload when the customer purchased an image option;
- trim choices and trim sizing when the customer purchased a trim option;
- estimated production timing; and
- a notice explaining that unpaid customization requests may be rejected.

Customers are only shown the customization tools included in the option they
selected. For example, a customer who paid for text only cannot add an image.

### Customer Images and Privacy

- Customers can upload an image for an eligible customized stole.
- Uploaded images are stored privately through Vercel Blob.
- The application checks file type, file size, ownership, and upload validity.
- One customer cannot attach an image to another customer's cart.
- Private images are not shown through public product or order pages.

### Shopping Cart

- Customers can shop as a guest or while signed in.
- Customers can add products to the cart.
- Customers can change quantities.
- Customers can remove products.
- Cart prices and item counts update after changes.
- Customized text, images, trim, fabric, quantity, price, and production details
  stay attached to the correct cart item.
- A guest cart can be moved into the customer's account after sign-in without
  losing customization information.

### Accounts

- Customers can create an account, sign in, sign out, and view their profile.
- Clerk provides the account and sign-in service.
- The application checks that sign-in information came from the correct Clerk
  account before allowing access.

### Checkout and Payment

- Customers can begin checkout from the cart.
- Stripe provides the secure payment page.
- Kapchi verifies the product, price, fabric, customization, and cart before
  starting payment.
- Customers are returned to Kapchi after payment or cancellation.
- The application avoids creating duplicate paid orders when requests or Stripe
  updates are repeated.
- A confirmation page shows whether payment is complete, pending, failed, or
  unavailable.
- Successful customers receive a public Kapchi order number.

### Order Tracking

- Customers can look up an order using the public order number and matching
  contact information.
- The order page shows purchased items, customization summaries, payment status,
  production status, and shipping progress.
- Carrier and tracking information appear after store staff confirm shipment.
- Internal product codes, payment-provider details, and private staff information
  are not shown to customers.

## 3. Features Available to Store Staff

The following staff features are **Implemented in source code**, except where a
different status is stated:

### Staff Security

- Staff pages and actions require an authorized administrator account.
- The server checks staff permissions instead of trusting information sent by
  the browser.
- Important staff actions are recorded for review.

### Order Management

- Staff can view a list of customer orders.
- Staff can filter orders by status and sort them by date.
- Staff can open an order to view customer, shipping, item, payment,
  customization, production, and history information.
- Staff can start production.
- Staff can mark an order ready to ship.
- Staff can correct an eligible shipping address.
- Staff can confirm shipment and enter carrier and tracking information.
- The application prevents invalid or out-of-date order changes.

### Customer Artwork Server Controls

**Status: Partially completed**

- The server can securely check whether authorized staff may access artwork
  attached to a paid order.
- The server rejects artwork that is unpaid, deleted, quarantined, attached to
  the wrong order, or otherwise invalid.
- Server-side access to private artwork is recorded.
- The staff order page does not yet provide the final artwork preview or download
  experience.

### Refund Server Controls

**Status: Partially completed**

- The server supports authorized full and partial Stripe refund requests.
- The server records the refund amount and progress.
- Repeated requests are handled so the same refund is not intentionally sent
  twice.
- The server can reconcile its records with Stripe when the result of a refund
  request is uncertain.
- The staff order page does not yet provide the final refund controls.

### Shipping Export

- Staff can select eligible orders for shipping.
- Staff can create and download a Pirate Ship-compatible spreadsheet.
- The application identifies orders with missing or invalid shipping details.
- Staff can cancel a prepared export or release an export after it expires.
- Exporting an order does not automatically mark it shipped.
- A human must still review and purchase labels through Pirate Ship.

### Customer Messages

The messaging system on the server is **Partially completed**. Its source code
can:

- keep messages connected to the correct order;
- store customer replies and private staff notes;
- prepare order confirmation, fulfillment, and refund messages;
- retry failed delivery when appropriate; and
- process secure updates from the message provider.

The staff-facing messaging screen, provider setup, and production delivery
verification are still required and are listed in Sections 5 and 6.

### Fabric Inventory

The inventory system on the server is **Implemented in source code**. It can:

- keep shared fabric quantities;
- reserve fabric for carts and orders;
- release expired reservations;
- record adjustments and sold quantities; and
- prevent available inventory from being oversold during simultaneous orders.

The staff-facing inventory screen is still Planned and is listed in Section 6.

### Sales Reports

A basic sales-reporting service is **Partially completed**. It currently supports
selected sales totals, paid-order counts, average order value, units sold, time
periods, best sellers, payment status, and fulfillment status.

The completed analytics feature described in Section 6 will add the remaining
refund, net-sales, comparison, and customer reporting requirements.

## 4. Behind-the-Scenes Features

The following operational features are **Implemented in source code**:

- PostgreSQL database storage for products, customers, carts, orders, messages,
  inventory, shipping, refunds, and related records.
- A controlled database update process that keeps track of database changes.
- Redis support for guest sessions, carts, temporary information, and preventing
  the same scheduled job from running twice at the same time.
- Stripe payment and refund connections.
- Clerk customer and staff authentication.
- Vercel Blob private image storage.
- Health checks for the application, database, and Redis, plus a check that the
  private file-storage credential is configured. The file-storage check does not
  prove that Vercel Blob can currently read or write files.
- Activity logs with request numbers, timing, results, and safe error codes.
- Redaction of named credential and authentication fields from normal logs.
  Production launch still requires a final review of every logged field and
  endpoint for personal or customer-provided information.
- Test data that is clearly marked and blocked from running against a production
  database.
- Automated tests for customer pages, staff pages, server behavior, database
  behavior, payments, uploads, refunds, and release checks.
- Automated secret scanning that detects recognized credential patterns in
  tracked files and example configuration files.

## 5. Built but Not Ready for Production Launch

The following work exists but still has a stated launch condition:

### Store Policies

**Status: Implemented, launch setup required**

Pages and version tracking exist for shipping, returns, privacy, and terms of
sale. Before publication:

- the store owner or a qualified lawyer must approve the wording;
- an approval record must be added;
- older checkout sessions that did not record the approved policy version must
  be handled; and
- the production policy check must pass.

### Production Launch Process

**Status: Implemented, launch setup required**

The repository includes launch, database update, monitoring, backup, restore,
and rollback instructions. The store must still configure and verify the real
production accounts, domains, backups, alerts, secrets, and final launch record.

### Final Staging Test Process

**Status: In review and partially completed**

Pull request #136 adds the plan and basic tools for a complete pre-launch test.
The following work is still required:

- connect the test process to the selected hosted database provider;
- create temporary test data and accounts safely;
- run the complete purchase, payment, fulfillment, tracking, and refund journey;
- collect proof from Stripe, Clerk, Vercel, and the message provider;
- remove temporary test data; and
- produce the final launch approval or rejection record.

### Test Data

**Status: Partially completed**

Safe local test data exists for the implemented shopping and staff workflows.
Temporary hosted test data for the final staging test is not complete.

### Background Jobs and Message Delivery

**Status: Implemented, launch setup required**

The source code includes protected workers for messages, refunds, inventory,
maintenance, and health checks. Before launch, the store must still:

- choose and configure the production message provider;
- verify real delivery, provider updates, and retry behavior;
- install the production schedule that starts each background worker;
- confirm that failed jobs create useful alerts; and
- record proof that the workers ran successfully in the staging environment.

No active production schedule is committed in the referenced source-code
version.

### Privacy and Logging Review

**Status: Implemented, launch setup required**

Credential redaction and structured logging exist, but the production launch
review must confirm that addresses, customization text, uploaded content, and
other personal information are not written to normal logs by any endpoint or
service.

## 6. Planned Features Not Included in the Current Delivery

The following features are **Planned**. They are not included in the current
implemented work unless the Client and Developer approve them in a written change
order.

| Planned feature | Plain-language description |
| --- | --- |
| Product removal and archiving | Let staff hide a product from future customers without deleting it from old orders. |
| Product management screen | Let staff create and edit products from the staff area. |
| Product customization controls | Let staff choose which text, image, trim, and font options are offered for each product. |
| Automatic Stripe product setup | Automatically create or update the matching Stripe product and price when staff create or reprice a Kapchi product. |
| Fabric inventory screen | Give staff a visual screen for stock, reserved amounts, sold amounts, adjustments, and products using each fabric. |
| Customer messaging screen | Let staff write and review customer messages directly from an order page. |
| Order search | Add a staff-facing search box for order numbers, customer details, and other supported fields. |
| Customer artwork screen | Let authorized staff preview or download eligible paid-order artwork from the order page. |
| Refund controls | Let authorized staff request and review eligible refunds from the order page. |
| Promotions and discount codes | Create discount codes, schedules, limits, product rules, checkout validation, and reporting. |
| Completed sales dashboard | Add complete net sales, refunds, comparisons, returning/new customer reporting, and matching order details. |
| Pirate Ship assistant | Help staff upload the shipping spreadsheet and review mappings, address warnings, rates, and results while requiring human approval before label purchase. |
| Hosted staging test data | Create temporary, clearly marked online test data that cannot affect production customers or payments. |
| Complete pre-launch test | Automatically verify the full customer purchase through staff fulfillment and refund process before launch. |
| Production launch execution | Configure the real services, run database updates, verify domains and security, test backups and rollback, monitor the release, and approve launch. |
| Policy publication | Obtain approval for the final policy wording and publish the approved versions. |
| Remaining staff dashboard screens | Finish the real-data Overview, Inventory, Promotions, and Messages screens. |

## 7. Client Responsibilities

Unless the main agreement says otherwise, the Client is responsible for:

- paying for and maintaining Vercel, PostgreSQL, Redis, Clerk, Stripe, messaging,
  domain, and Pirate Ship accounts;
- providing accurate products, prices, fabric information, inventory, images,
  cultural and brand content, and customer-service procedures;
- approving production access, staff accounts, and provider settings;
- providing or approving shipping, return, privacy, and sales terms;
- obtaining legal, tax, privacy, and accounting advice when needed;
- reviewing Stripe payments, refunds, payouts, disputes, and tax settings;
- approving Pirate Ship label purchases; and
- completing the final launch approval after reviewing the required evidence.

The Developer is not responsible for third-party downtime, account suspension,
provider price changes, payment declines, carrier delays, email/SMS delivery
decisions, or provider approval delays unless the problem was directly caused by
the Developer's failure to build the agreed connection correctly.

## 8. Acceptance Process

1. The Developer will identify the exact source-code version and test environment
   being delivered and provide reasonable instructions for testing it.
2. The review period begins only after the Developer gives written notice that
   the identified version is ready for review. The Client will then have `[10]`
   business days to review it.
3. Before review begins, the parties will agree in writing on the important test
   examples, supported browsers and screen sizes, and any outside services needed
   for the review.
4. If the Client believes an implemented feature does not meet this document,
   the Client will provide the feature name, expected result, actual result,
   test environment, and reasonable steps for repeating the problem.
5. A reproducible failure to meet an agreed requirement is a defect. A new
   preference, changed design, or feature not identified as implemented is a
   change request.
6. The Developer will correct covered defects during the correction period in
   the main agreement and resubmit the affected feature for review. Features not
   affected by the defect may be accepted separately.
7. A feature is accepted only when the Client approves it in writing. Use of a
   test or production environment, or silence during the review period, does not
   by itself create acceptance unless the main agreement expressly says so.
8. A third-party outage, rejection, or delivery failure is not a software defect
   unless the agreed Kapchi connection caused or mishandled it.
9. Features marked “launch setup required” are not accepted for production use
   until their listed launch conditions are completed.

## 9. Items Not Included Unless Added in Writing

The current delivery does not include:

- a native iPhone, iPad, or Android application;
- a general-purpose content management system;
- legal advice or final legal policy wording;
- tax registration, tax advice, accounting, or customs advice;
- automatic Pirate Ship label purchase;
- bypassing passwords, multi-factor authentication, CAPTCHA, payment approval,
  or other account protections;
- migration from an unidentified older store or database;
- a guarantee that Stripe will approve a payment;
- a guarantee that carriers will deliver by a particular date;
- a guarantee that email or text messages will be delivered by a provider;
- round-the-clock support or incident response; or
- any planned feature in Section 6 unless approved by written change order.

## 10. Changes to the Work

New features or material changes to the items in this document require a written
change order approved by both parties. The change order should identify:

- the feature being added or changed;
- the price;
- the expected delivery date;
- what the Client must provide; and
- how the parties will decide that the work is complete.

## 11. Signatures

By signing below, the parties agree that:

- Sections 2 through 4 describe what exists in the referenced source code;
- Section 5 describes work that still has launch conditions; and
- Section 6 describes future work that is not currently included.

| Client | Developer |
| --- | --- |
| Name: `[NAME]` | Name: `[NAME]` |
| Title: `[TITLE]` | Title: `[TITLE]` |
| Signature: ____________________ | Signature: ____________________ |
| Date: _________________________ | Date: _________________________ |

## Appendix: Project References

- Implemented application baseline: `main` commit `97412a3`
- Pre-launch test foundation currently in review: pull request #136 at commit
  `8dbd7264b9288611a7c05da3c5d5ad8abdbadbcf`
- Planned work is tracked in GitHub issues #10, #17, #18, #20, #30, #31, #33,
  #85, #99, #102, #104, #114, #115, and #117.
