import type { AdminOrderDetail, AdminOrderSearchPage, AdminOrderSummary } from "./types";

const money = (amountMinor: number) => ({ amountMinor, currency: "USD" });

export function createAdminOrderSummary(
  overrides: Partial<AdminOrderSummary> = {},
): AdminOrderSummary {
  return {
    createdAt: "2026-10-28T14:30:00.000Z",
    customer: {
      email: "maya@example.com",
      name: "Maya Quispe",
      phone: "+1 555 0100",
      preferredContactMethod: "email",
    },
    discount: money(0),
    fulfillmentStatus: "in_progress",
    id: "11111111-1111-4111-8111-111111111111",
    itemCount: 1,
    payment: {
      captured: money(18500),
      currencyIntegrity: "consistent",
      pendingRefunds: money(0),
      refundableBalance: money(18500),
      succeededRefunds: money(0),
    },
    paymentStatus: "paid",
    publicOrderNumber: "KAP-1042",
    revision: 2,
    status: "in_production",
    total: money(18500),
    totalQuantity: 2,
    updatedAt: "2026-10-28T15:00:00.000Z",
    ...overrides,
  };
}

export function createAdminOrderPage(
  overrides: Partial<AdminOrderSearchPage> = {},
): AdminOrderSearchPage {
  return { nextCursor: null, orders: [createAdminOrderSummary()], ...overrides };
}

export function createAdminOrderDetail(
  overrides: Partial<AdminOrderDetail> = {},
): AdminOrderDetail {
  const summary = createAdminOrderSummary();
  return {
    ...summary,
    cancelledAt: null,
    completedAt: null,
    contactSnapshot: summary.customer,
    items: [
      {
        catalogReference: { fabricStatus: "active", listingStatus: "active" },
        currency: "USD",
        customizationAsset: { recordStatus: "uploaded", unavailableReason: null },
        id: "22222222-2222-4222-8222-222222222222",
        production: {
          availability: {
            font: "present",
            placement: "present",
            text: "present",
            trim: "present",
          },
          estimateSnapshot: {
            maximumBusinessDays: 7,
            minimumBusinessDays: 5,
            priorityCode: "standard",
            priorityLabel: "Standard",
            ruleId: "never-render",
          },
          font: { family: "Garamond", providerToken: "never-render" },
          placement: { position: "Left panel", internalNote: "never-render" },
          priorityCode: "standard",
          text: { line1: "Class of 2026", line2: "Maya" },
          trim: { color: "Gold", width: "1 inch", stripePriceId: "never-render" },
        },
        productionNotes: "Match the approved customer proof.",
        quantity: 2,
        snapshots: {
          customization: {
            levelName: "Text (long) + Image + Trim",
            imageAssetId: "asset-private",
            internalNote: "never-render",
          },
          fabric: { color: "Royal blue", providerId: "never-render" },
          listing: { title: "Classic graduation stole", stripeProductId: "never-render" },
        },
        total: money(18500),
        unitPrice: money(9250),
      },
    ],
    paidAt: "2026-10-28T14:35:00.000Z",
    shippedAt: null,
    shipping: {
      address: {
        city: "Brooklyn",
        country: "US",
        line1: "100 Main Street",
        postalCode: "11201",
        secretCode: "never-render",
        state: "NY",
      },
      name: "Maya Quispe",
    },
    ...overrides,
  };
}
