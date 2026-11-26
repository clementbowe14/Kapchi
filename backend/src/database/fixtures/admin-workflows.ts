export const FIXTURE_NAMESPACE = "kapchi.admin-workflows.v1";
export const FIXTURE_MARKER_ID = "85d4a1ab-5a3c-4edf-a8e9-000000000085";
export const FIXTURE_ADVISORY_LOCK_KEY = 850_001_002;
export const FIXTURE_ADMIN_SUBJECT = "fixture_clerk_admin_unbound";

export const reportingWindows = {
  previous: {
    startInclusive: "2026-09-01T00:00:00.000Z",
    endExclusive: "2026-10-01T00:00:00.000Z"
  },
  current: {
    startInclusive: "2026-10-01T00:00:00.000Z",
    endExclusive: "2026-11-01T00:00:00.000Z"
  }
} as const;

export const fixtureTimes = {
  activeReservationExpiresAt: "2099-01-01T00:00:00.000Z",
  base: "2026-10-01T12:00:00.000Z",
  previousOrder: "2026-09-15T12:00:00.000Z"
} as const;

export type FixtureIdentity = {
  contactId?: string;
  customerId?: string;
  displayName: string;
  email?: string;
  key: string;
  phone?: string;
  preferredContactMethod?: "email" | "sms" | "phone";
  userId?: string;
  authSubject?: string;
};

export const fixtureIdentities: readonly FixtureIdentity[] = [
  {
    authSubject: FIXTURE_ADMIN_SUBJECT,
    displayName: "Fixture Admin",
    email: "admin@example.test",
    key: "identity.admin",
    userId: "85000000-0000-4000-8000-000000000001"
  },
  {
    authSubject: "fixture_customer_returning",
    contactId: "85000000-0000-4000-8000-000000000201",
    customerId: "85000000-0000-4000-8000-000000000101",
    displayName: "Returning Fixture Customer",
    email: "returning@example.test",
    key: "identity.returning",
    phone: "+12025550101",
    preferredContactMethod: "email",
    userId: "85000000-0000-4000-8000-000000000002"
  },
  {
    authSubject: "fixture_customer_new",
    contactId: "85000000-0000-4000-8000-000000000202",
    customerId: "85000000-0000-4000-8000-000000000102",
    displayName: "New Fixture Customer",
    email: "new@example.test",
    key: "identity.new",
    phone: "+12025550102",
    preferredContactMethod: "email",
    userId: "85000000-0000-4000-8000-000000000003"
  },
  {
    contactId: "85000000-0000-4000-8000-000000000203",
    customerId: "85000000-0000-4000-8000-000000000103",
    displayName: "Guest Fixture Customer",
    email: "guest@example.test",
    key: "identity.guest",
    phone: "+12025550103",
    preferredContactMethod: "email"
  },
  {
    contactId: "85000000-0000-4000-8000-000000000204",
    customerId: "85000000-0000-4000-8000-000000000104",
    displayName: "SMS Fixture Customer",
    key: "identity.sms",
    phone: "+12025550104",
    preferredContactMethod: "sms"
  },
  {
    customerId: "85000000-0000-4000-8000-000000000105",
    displayName: "Missing Contact Fixture",
    email: "missing-contact@example.test",
    key: "identity.missing-contact"
  }
] as const;

export type FixtureOrder = {
  cartId?: string;
  createdAt: string;
  currency: "usd" | "eur";
  customerKey: "returning" | "new" | "guest" | "sms" | "missing-contact";
  discountCents: number;
  fulfillmentStatus:
    | "not_started"
    | "queued"
    | "in_progress"
    | "ready_to_ship"
    | "shipped"
    | "delivered"
    | "cancelled";
  id: string;
  itemId: string;
  key: string;
  paymentStatus:
    | "unpaid"
    | "paid"
    | "failed"
    | "refunded"
    | "partially_refunded";
  publicOrderNumber: string;
  quantity: number;
  scenario: string;
  status:
    | "pending_payment"
    | "paid"
    | "in_production"
    | "ready_to_ship"
    | "shipped"
    | "completed"
    | "cancelled";
  unitAmountCents: number;
  variantKey: "blank" | "text-short" | "text-long" | "text-long-image" | "text-image-trim";
  withArtwork?: boolean;
  withProductionEstimate?: boolean;
};

export const fixtureOrders: readonly FixtureOrder[] = [
  ["previous", "85000000-0000-4000-8000-000000001001", "85000000-0000-4000-8000-000000002001", "FIXTURE-0901", fixtureTimes.previousOrder, "paid", "paid", "queued", "returning", "text-short", 5000, 1, 0, "usd", true],
  ["unpaid", "85000000-0000-4000-8000-000000001002", "85000000-0000-4000-8000-000000002002", "FIXTURE-1001", "2026-10-02T12:00:00.000Z", "pending_payment", "unpaid", "not_started", "guest", "blank", 4500, 1, 0, "usd", false],
  ["queue", "85000000-0000-4000-8000-000000001003", "85000000-0000-4000-8000-000000002003", "LOCAL-SEED-1001", "2026-10-03T12:00:00.000Z", "paid", "paid", "queued", "returning", "text-short", 5000, 1, 0, "usd", true],
  ["production", "85000000-0000-4000-8000-000000001004", "85000000-0000-4000-8000-000000002004", "FIXTURE-1003", "2026-10-04T12:00:00.000Z", "in_production", "paid", "in_progress", "new", "text-long-image", 6000, 1, 500, "usd", true],
  ["ready", "85000000-0000-4000-8000-000000001005", "85000000-0000-4000-8000-000000002005", "FIXTURE-1004", "2026-10-05T12:00:00.000Z", "ready_to_ship", "paid", "ready_to_ship", "guest", "blank", 4500, 1, 0, "usd", true],
  ["partial-shipment", "85000000-0000-4000-8000-000000001006", "85000000-0000-4000-8000-000000002006", "FIXTURE-1005", "2026-10-06T12:00:00.000Z", "shipped", "paid", "shipped", "sms", "blank", 1800, 2, 0, "usd", false],
  ["delivered", "85000000-0000-4000-8000-000000001007", "85000000-0000-4000-8000-000000002007", "FIXTURE-1006", "2026-10-07T12:00:00.000Z", "completed", "paid", "delivered", "returning", "text-image-trim", 6500, 1, 0, "usd", true],
  ["partial-refund", "85000000-0000-4000-8000-000000001008", "85000000-0000-4000-8000-000000002008", "FIXTURE-1007", "2026-10-08T12:00:00.000Z", "completed", "partially_refunded", "delivered", "new", "text-long", 5500, 1, 0, "usd", true],
  ["full-refund", "85000000-0000-4000-8000-000000001009", "85000000-0000-4000-8000-000000002009", "FIXTURE-1008", "2026-10-09T12:00:00.000Z", "cancelled", "refunded", "cancelled", "guest", "blank", 1800, 1, 0, "usd", false],
  ["failed-refund", "85000000-0000-4000-8000-000000001010", "85000000-0000-4000-8000-000000002010", "FIXTURE-1009", "2026-10-10T12:00:00.000Z", "paid", "paid", "queued", "returning", "blank", 4500, 1, 0, "usd", true],
  ["missing-production", "85000000-0000-4000-8000-000000001011", "85000000-0000-4000-8000-000000002011", "FIXTURE-1010", "2026-10-11T12:00:00.000Z", "paid", "paid", "not_started", "missing-contact", "blank", 1800, 1, 0, "usd", false],
  ["currency-exclusion", "85000000-0000-4000-8000-000000001012", "85000000-0000-4000-8000-000000002012", "FIXTURE-EUR-1", "2026-10-12T12:00:00.000Z", "paid", "paid", "queued", "new", "blank", 1000, 1, 0, "eur", false],
  ["cancelled", "85000000-0000-4000-8000-000000001013", "85000000-0000-4000-8000-000000002013", "FIXTURE-1011", "2026-10-13T12:00:00.000Z", "cancelled", "paid", "cancelled", "guest", "blank", 4500, 1, 0, "usd", false]
].map((row) => ({
  key: row[0] as string,
  scenario: row[0] as string,
  id: row[1] as string,
  itemId: row[2] as string,
  publicOrderNumber: row[3] as string,
  createdAt: row[4] as string,
  status: row[5] as FixtureOrder["status"],
  paymentStatus: row[6] as FixtureOrder["paymentStatus"],
  fulfillmentStatus: row[7] as FixtureOrder["fulfillmentStatus"],
  customerKey: row[8] as FixtureOrder["customerKey"],
  variantKey: row[9] as FixtureOrder["variantKey"],
  unitAmountCents: row[10] as number,
  quantity: row[11] as number,
  discountCents: row[12] as number,
  currency: row[13] as FixtureOrder["currency"],
  withProductionEstimate: row[14] as boolean,
  withArtwork: row[0] === "production"
}));

export const fixtureCarts = {
  active: {
    id: "85000000-0000-4000-8000-000000003001",
    itemId: "85000000-0000-4000-8000-000000003101",
    reservationId: "85000000-0000-4000-8000-000000003201"
  },
  converted: {
    id: "85000000-0000-4000-8000-000000003002",
    itemId: "85000000-0000-4000-8000-000000003102",
    reservationId: "85000000-0000-4000-8000-000000003202"
  }
} as const;

export const fixtureAssets = {
  artwork: {
    id: "85000000-0000-4000-8000-000000004001",
    storageKey: "fixture-only/artwork/class-of-2026.png",
    url: "https://example.test/fixture-only/artwork/class-of-2026.png"
  }
} as const;

export const fixtureFulfillments = {
  queue: "85000000-0000-4000-8000-000000005001",
  production: "85000000-0000-4000-8000-000000005002",
  ready: "85000000-0000-4000-8000-000000005003",
  partial: "85000000-0000-4000-8000-000000005004",
  delivered: "85000000-0000-4000-8000-000000005005"
} as const;

export const fixtureShipments = {
  ready: "85000000-0000-4000-8000-000000006001",
  partial: "85000000-0000-4000-8000-000000006002",
  delivered: "85000000-0000-4000-8000-000000006003"
} as const;

export const fixtureExports = {
  cancelledBatch: "85000000-0000-4000-8000-000000007001",
  cancelledItem: "85000000-0000-4000-8000-000000007101",
  expiredBatch: "85000000-0000-4000-8000-000000007002",
  expiredItem: "85000000-0000-4000-8000-000000007102"
} as const;

// These values are deliberately reviewed constants, not derived from fixtureOrders.
export const expectedCurrentUsdAnalytics = {
  bestSellers: [
    {
      grossSalesMinor: 36500,
      label: "Classic Graduation Stole",
      productKey: "85000000-0000-4000-8000-000000010001",
      unitsSold: 7
    },
    {
      grossSalesMinor: 7200,
      label: "Gold Honor Cord",
      productKey: "85000000-0000-4000-8000-000000010002",
      unitsSold: 4
    }
  ],
  fulfillmentBreakdown: [
    { status: "not_started", count: 2 },
    { status: "queued", count: 2 },
    { status: "in_progress", count: 1 },
    { status: "ready_to_ship", count: 1 },
    { status: "shipped", count: 1 },
    { status: "delivered", count: 2 },
    { status: "cancelled", count: 2 }
  ],
  metrics: {
    averageOrderValueMinor: 4320,
    discountMinor: 500,
    grossSalesMinor: 43700,
    netSalesMinor: 38005,
    paidOrderCount: 10,
    successfulRefundsMinor: 5195,
    unitsSold: 11
  },
  paymentBreakdown: [
    { status: "unpaid", count: 1 },
    { status: "paid", count: 8 },
    { status: "refunded", count: 1 },
    { status: "partially_refunded", count: 1 }
  ]
} as const;

export const safeShippingAddress = {
  city: "Fixture City",
  country: "US",
  line1: "DO NOT SHIP - TEST FIXTURE",
  postalCode: "10001",
  state: "NY"
} as const;

export function fixtureOrder(key: string) {
  const order = fixtureOrders.find((candidate) => candidate.key === key);
  if (!order) throw new Error(`Unknown fixture order key: ${key}`);
  return order;
}
