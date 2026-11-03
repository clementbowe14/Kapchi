# Pirate Ship Export Runbook

Use this workflow only for U.S. orders shown as eligible in **Admin > Ongoing orders**. Pirate Ship does not provide a public API, so Kapchi creates a private CSV for a human-operated import. Never automate private Pirate Ship endpoints.

## Prepare The Batch

1. Filter the order queue to **Ready to ship**.
2. Select only the orders that should share the same Pirate Ship package type and batch-level options.
3. Choose **Prepare export**. Resolve every preflight error before continuing.
4. Enter weight in ounces and length, width, and height in inches for every order. Review decimal placement carefully.
5. Create the export once. If the request times out, use **Recover export**. Do not alter measurements or create a second request while the result is unknown.
6. Download the CSV. A failed download is retried from the existing batch and must not create another export.

The durable **Shipping exports** page can reopen a prepared or unresolved expired batch after a browser restart. Batch IDs and exact shipment IDs are the authoritative reconciliation data.

## Mapping V1

Map the generated columns in this exact order:

| Kapchi header | Pirate Ship value |
| --- | --- |
| Order ID | Order/reference ID |
| Full Name | Recipient full name |
| Company | Company |
| Email | Recipient email |
| Phone | Recipient phone |
| Address Line 1 | Street address |
| Address Line 2 | Unit/suite |
| City | City |
| State | State |
| Zip | ZIP code |
| Country | Country |
| Weight (Ounces) | Per-row package weight override |
| Length | Per-row length override |
| Width | Per-row width override |
| Height | Per-row height override |
| Order Items | Order description |
| Order Item Count | Item quantity |
| Note | Fixed Kapchi marker |
| Kapchi Reference | Opaque reconciliation reference |

Choose one common package type and common service/customs options for the upload. The four measurement columns override the default package dimensions per row. Version 1 is domestic U.S. only and does not support customs forms.

## Upload And Verify

1. Download the file from Kapchi immediately before use.
2. Upload the generated CSV directly to Pirate Ship. Do not open, edit, or resave it in Excel, Numbers, Google Sheets, or another spreadsheet application; those tools can alter ZIP codes, phone values, quoting, Unicode, and decimal formatting.
3. On the first staging import and after every mapping change, verify at least one row containing:
   - a ZIP code beginning with zero;
   - an optional phone number;
   - a recipient or item value containing quotes;
   - normalized internal whitespace;
   - non-integer package measurements.
4. Compare the Pirate Ship import preview with Kapchi before proceeding. Confirm row count, public order ID, recipient, full address, dimensions, weight, item count, and Kapchi reference.
5. If an address or package value needs a material correction, stop. Make the correction in Kapchi, cancel the batch with the required certification, remove the Pirate Ship draft, delete local CSV copies, and create a fresh export.

## Human Approval Boundaries

Uploading discloses customer contact and delivery data to Pirate Ship. The administrator must approve the exact batch and row count in Kapchi before opening Pirate Ship.

Stop again before any label purchase or charge. A human administrator must review the displayed addresses, rates, services, package details, total charge, and batch identity and explicitly approve purchase. Approval is never remembered for later batches.

An assistant or browser agent must not access credentials, cookies, session tokens, password managers, MFA prompts, CAPTCHA challenges, payment controls, or unrelated downloads. The administrator signs in and controls all purchase actions. Browser automation, if introduced, belongs to issue #30 and cannot weaken these boundaries.

## Record Tracking

After labels are purchased, return to **Shipping exports** and choose **Enter tracking** for each row. The link carries the exact shipment ID from that batch. Enter carrier, optional service, and tracking number, then confirm. Exporting alone never marks an order shipped; only successful tracking confirmation does.

Do not select a different shipment when the order has more than one historical shipment. Confirm the exact ID shown in the export recovery view.

## Cancel Or Release

Cancel a prepared export only after verifying that no label was purchased. The cancellation requires a reason and the `no label purchased` certification. Then delete every local copy and remove the matching Pirate Ship draft before re-exporting.

Expired exports cannot be downloaded. If a label was purchased, enter tracking for the exact shipment. If no label was purchased, use **Release expired export**, provide a reason, certify that no label was purchased, delete local files, and remove the Pirate Ship draft. Release does not change order status or restore the expired file.

Never cancel or release merely because tracking is delayed. When purchase status is uncertain, pause and reconcile Pirate Ship against the Kapchi batch ID and public order IDs first.

## Incident Checks

- **Unknown create result:** recover with the same request key in the still-open dialog, or check **Shipping exports** before trying again.
- **Download failure:** retry download on the existing batch only.
- **Wrong address:** cancel/release first, correct the address in Kapchi, and create a new export.
- **Expired after purchase:** enter tracking; do not release.
- **Duplicate or conflicting shipment:** stop and escalate for data review. Do not guess or delete history.
- **Session expired:** sign in again, reopen **Shipping exports**, and continue from durable batch state.
- **Suspected data exposure:** stop using the file, preserve the non-PII batch ID for investigation, follow the incident process, and do not paste CSV contents into tickets or logs.
