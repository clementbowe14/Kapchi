# Exhibit A: Kapchi Website Features

**Application:** Kapchi Store

**Document purpose:** Plain-language list of completed and planned work

**Completed-work reference:** `main` at commit `97412a3`

**Status date:** November 15, 2026

**Client:** `[CLIENT LEGAL NAME]`

**Developer:** `[DEVELOPER LEGAL NAME]`

**Effective date:** `[EFFECTIVE DATE]`

This document may be attached to a software development agreement or statement
of work. It explains what has already been built, what still needs preparation
before launch, and what is only planned for the future.

The parties should complete the names, dates, payment terms, ownership terms,
support terms, and other legal terms in the main agreement. A lawyer should
review the final agreement before it is signed.

## Quick Summary

Kapchi currently allows customers to browse and customize graduation stoles,
upload artwork, use a shopping cart, pay through Stripe, receive an order number,
and track an order. Authorized store staff can review orders, move them through
production, access purchased artwork, issue refunds, prepare Pirate Ship export
files, and confirm tracking. The remaining major work is staff-facing product,
inventory, messaging, promotion, and complete reporting screens, plus final
production setup and full pre-launch testing.

## 1. How to Read This Document

| Status | Meaning |
| --- | --- |
| **Completed** | The feature has been built and is included in the current version of the application. |
| **Built, but not ready for launch** | Most or all of the feature has been built, but approval, setup, or final testing is still required. |
| **In review** | The work has been written but has not yet been approved and added to the main application. |
| **Partially completed** | Part of the feature works, but more work is required to provide the full feature. |
| **Planned** | The feature has not been completed. It is not included in the current delivery unless the parties approve it in writing. |

## 2. Features Available to Customers

The following customer features are **Completed**:

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

The following staff features are **Completed**:

### Staff Security

- Staff pages and actions require an authorized administrator account.
- The server checks staff permissions instead of trusting information sent by
  the browser.
- Important staff actions are recorded for review.

### Order Management

- Staff can view a list of customer orders.
- Staff can search and filter orders.
- Staff can open an order to view customer, shipping, item, payment,
  customization, production, and history information.
- Staff can start production.
- Staff can mark an order ready to ship.
- Staff can correct an eligible shipping address.
- Staff can confirm shipment and enter carrier and tracking information.
- The application prevents invalid or out-of-date order changes.

### Customer Artwork

- Authorized staff can view artwork attached to a paid order.
- Staff cannot access artwork that is unpaid, deleted, quarantined, attached to
  the wrong order, or otherwise invalid.
- Access to private artwork is recorded.

### Refunds

- Authorized staff can request full or partial Stripe refunds.
- The application records the refund amount and progress.
- Repeated requests are handled so the same refund is not intentionally sent
  twice.
- The application can reconcile its records with Stripe when the result of a
  refund request is uncertain.

### Shipping Export

- Staff can select eligible orders for shipping.
- Staff can create and download a Pirate Ship-compatible spreadsheet.
- The application identifies orders with missing or invalid shipping details.
- Staff can cancel or expire an export batch.
- Exporting an order does not automatically mark it shipped.
- A human must still review and purchase labels through Pirate Ship.

### Customer Messages

The messaging system on the server is **Completed**. It can:

- keep messages connected to the correct order;
- store customer replies and private staff notes;
- prepare order confirmation, fulfillment, and refund messages;
- retry failed delivery when appropriate; and
- process secure updates from the message provider.

The staff-facing messaging screen is still Planned and is listed in Section 6.

### Fabric Inventory

The inventory system on the server is **Completed**. It can:

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

The following operational features are **Completed**:

- PostgreSQL database storage for products, customers, carts, orders, messages,
  inventory, shipping, refunds, and related records.
- A controlled database update process that keeps track of database changes.
- Redis support for guest sessions, carts, temporary information, and preventing
  the same scheduled job from running twice at the same time.
- Stripe payment and refund connections.
- Clerk customer and staff authentication.
- Vercel Blob private image storage.
- Health checks that report whether the application, database, Redis, and file
  storage are ready.
- Scheduled work for messages, refunds, inventory, maintenance, and health
  checks.
- Activity logs with request numbers, timing, results, and safe error codes.
- Removal of passwords, tokens, addresses, uploaded text, and private provider
  information from normal logs.
- Test data that is clearly marked and blocked from running against a production
  database.
- Automated tests for customer pages, staff pages, server behavior, database
  behavior, payments, uploads, refunds, and release checks.
- Automated secret scanning and checks that prevent real credentials from being
  stored in example files.

## 5. Built but Not Ready for Production Launch

The following work exists but still has a stated launch condition:

### Store Policies

**Status: Built, but not ready for launch**

Pages and version tracking exist for shipping, returns, privacy, and terms of
sale. Before publication:

- the store owner or a qualified lawyer must approve the wording;
- an approval record must be added;
- older checkout sessions that did not record the approved policy version must
  be handled; and
- the production policy check must pass.

### Production Launch Process

**Status: Built, but not ready for launch**

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

## 6. Planned Features Not Included in the Current Delivery

The following features are **Planned**. They are not included in the current
completed work unless the Client and Developer approve them in a written change
order.

| Planned feature | Plain-language description |
| --- | --- |
| Product removal and archiving | Let staff hide a product from future customers without deleting it from old orders. |
| Product management screen | Let staff create and edit products from the staff area. |
| Product customization controls | Let staff choose which text, image, trim, and font options are offered for each product. |
| Automatic Stripe product setup | Automatically create or update the matching Stripe product and price when staff create or reprice a Kapchi product. |
| Fabric inventory screen | Give staff a visual screen for stock, reserved amounts, sold amounts, adjustments, and products using each fabric. |
| Customer messaging screen | Let staff write and review customer messages directly from an order page. |
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

1. The Developer will identify the version being delivered and provide reasonable
   instructions for testing it.
2. The Client will have `[10]` business days to review the delivered features.
3. If the Client believes a completed feature does not meet this document, the
   Client will provide the feature name, expected result, actual result, and
   reasonable steps for repeating the problem.
4. A reproducible failure to meet a stated completed feature is a defect. A new
   preference, changed design, or feature not listed as completed is a change
   request.
5. The Developer will correct covered defects during the correction period in
   the main agreement and resubmit the feature for review.
6. A feature is accepted when the Client approves it in writing, uses it in
   production, or does not provide a valid rejection during the review period,
   subject to the terms of the main agreement.
7. Features marked “not ready for launch” are not accepted for production use
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

- Sections 2 through 4 describe the current completed work;
- Section 5 describes work that still has launch conditions; and
- Section 6 describes future work that is not currently included.

| Client | Developer |
| --- | --- |
| Name: `[NAME]` | Name: `[NAME]` |
| Title: `[TITLE]` | Title: `[TITLE]` |
| Signature: ____________________ | Signature: ____________________ |
| Date: _________________________ | Date: _________________________ |

## Appendix: Project References

- Completed application baseline: `main` commit `97412a3`
- Pre-launch test foundation currently in review: pull request #136
- Planned work is tracked in GitHub issues #10, #17, #18, #20, #30, #31, #33,
  #85, #99, #102, #104, #114, #115, and #117.
