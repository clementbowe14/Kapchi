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
  netSalesMinor: number;
  paidOrderCount: number;
  startInclusive: string;
  successfulRefundsMinor: number;
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
      available: true;
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
    netSalesDefinition: "merchandise_less_discounts_less_unallocated_successful_payment_refunds";
    refundCohort: "associated_with_orders_in_created_at_cohort";
    refundCoverage: "recorded_ledger_only";
    source: "postgresql";
  };
  metrics: {
    averageOrderValueMinor: number;
    discountMinor: number;
    grossSalesMinor: number;
    netSalesMinor: number;
    paidOrderCount: number;
    successfulRefundsMinor: number;
    unitsSold: number;
  };
  paymentBreakdown: SalesBreakdown[];
  timeBuckets: SalesTimeBucket[];
};
