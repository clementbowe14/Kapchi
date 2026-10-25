# Shipping label workflow

Kapchi does not call Shippo and does not require `SHIPPO_API_KEY` or another
shipping-provider credential at build time, startup, or runtime. Label purchase
currently happens outside Kapchi through Pirate Ship with an administrator in
control of every purchase.

## Current manual workflow

1. An authorized administrator reviews the order, shipping address, items, and
   fulfillment state in Kapchi.
2. The administrator enters the shipment in Pirate Ship using its normal
   authenticated website. Kapchi never collects or stores Pirate Ship login
   credentials.
3. The administrator reviews address corrections, package details, service,
   rate, and purchase total in Pirate Ship before approving the label purchase.
4. After purchase, the administrator records the carrier and tracking number in
   Kapchi through the fulfillment workflow owned by issue #21.
5. Kapchi marks an order shipped only after confirmed tracking data is stored.

Until the fulfillment mutation in issue #21 is available, label creation and
tracking reconciliation remain an explicit manual operational step. The app
must not claim that a label was purchased or that an order shipped based only
on an export or an attempted browser action.

## Planned assistance

Issue #29 owns a stable Pirate Ship-compatible order export and tracking import
workflow. Issue #30 may add browser assistance on top of that export. Both must
keep these boundaries:

- Pirate Ship does not provide a public API contract for Kapchi to depend on.
- Login, CAPTCHA, account protection, rate selection, and label purchase remain
  in Pirate Ship.
- An administrator must explicitly approve every irreversible purchase.
- Credentials and payment details are never stored in the repository or Kapchi
  database.
- Exported customer data is limited to the selected orders, handled as
  sensitive data, and removed according to the store's retention policy.
- Tracking updates are idempotent and auditable before order state changes.

## Secret response

Repository history contains only the former `shippo_replace_me` placeholder;
no Shippo credential-shaped value was found during the issue #28 audit. If a
real Shippo token was ever pasted into an untracked env file, terminal output,
chat, CI setting, or deployment platform, revoke it in Shippo and remove it
from that system. Deleting a repository line does not invalidate an exposed
credential.
