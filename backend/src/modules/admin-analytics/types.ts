export type SalesBucketGranularity = "day" | "week" | "month";

export type SalesAnalyticsQuery = {
  bestSellerLimit: number;
  bucket: SalesBucketGranularity;
  currency: string;
  endDate: string;
  startDate: string;
  timezone: string;
};

export type SalesBreakdown = {
  count: number;
  status: string;
};

export type SalesTimeBucket = {
  discountMinor: number;
  endExclusive: string;
  grossSalesMinor: number;
  netSalesMinor: null;
  paidOrderCount: number;
  startInclusive: string;
  successfulRefundsMinor: null;
  unitsSold: number;
};

export type SalesBestSeller = {
  grossSalesMinor: number;
  label: string;
  productKey: string;
  unitsSold: number;
};

export type SalesAnalyticsReport = {
  bestSellers: SalesBestSeller[];
  capabilities: {
    refunds: {
      available: false;
      reason: "REFUND_LEDGER_UNAVAILABLE";
      dependencyIssue: 103;
    };
  };
  cohort: {
    basis: "order_created_at";
    bucket: SalesBucketGranularity;
    dateBoundaryTimezone: "UTC";
    currency: string;
    endDateInclusive: string;
    endExclusive: string;
    startDateInclusive: string;
    startInclusive: string;
    bucketTimezone: string;
  };
  fulfillmentBreakdown: SalesBreakdown[];
  metadata: {
    amountUnit: "minor";
    grossSalesDefinition: "merchandise_before_discounts_shipping_tax_and_refunds";
    netSalesDefinition: "unavailable_until_refund_ledger";
    refundCohort: "associated_with_orders_in_created_at_cohort";
    source: "postgresql";
  };
  metrics: {
    averageOrderValueMinor: number;
    discountMinor: number;
    grossSalesMinor: number;
    netSalesMinor: null;
    paidOrderCount: number;
    successfulRefundsMinor: null;
    unitsSold: number;
  };
  paymentBreakdown: SalesBreakdown[];
  timeBuckets: SalesTimeBucket[];
};
