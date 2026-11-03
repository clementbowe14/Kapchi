export type PackageMeasurements = {
  description: string;
  heightInches: string;
  lengthInches: string;
  weightOunces: string;
  widthInches: string;
};

export type ShippingExportCandidate = {
  codes: string[];
  eligible: boolean;
  existingPackage: PackageMeasurements | null;
  orderId: string;
  publicOrderNumber: string;
  revision: number;
};

export type ShippingExportPreflight = {
  candidates: ShippingExportCandidate[];
};

export type ShippingExportBatchItem = {
  orderId: string;
  publicOrderNumber: string;
  shipmentId: string;
};

export type ShippingExportBatchStatus = "prepared" | "cancelled" | "expired";

export type ShippingExportBatch = {
  allowedActions: Array<"cancel" | "confirm_shipment" | "download" | "release">;
  batchId: string;
  createdAt: string | null;
  downloadPath: string | null;
  expiresAt: string;
  filename: string;
  items: ShippingExportBatchItem[];
  mappingVersion: number;
  rowCount: number;
  status: ShippingExportBatchStatus;
};

export type ShippingExportBatchPage = {
  batches: ShippingExportBatch[];
  nextCursor: string | null;
};

export type CreateShippingExportInput = {
  orders: Array<{
    expectedRevision: number;
    orderId: string;
    package: {
      description?: string;
      heightInches: number;
      lengthInches: number;
      weightOunces: number;
      widthInches: number;
    };
  }>;
};

export type ShippingExportWorkflowState =
  | "idle"
  | "preflighting"
  | "editing"
  | "creating"
  | "creation_unknown"
  | "recovering"
  | "created"
  | "downloading"
  | "download_failed"
  | "downloaded";

export type CorrectShippingAddressInput = {
  address: {
    city: string;
    country: "US";
    line1: string;
    line2?: string;
    postalCode: string;
    state: string;
  };
  expectedRevision: number;
  intent: "correct_shipping_address";
  name: string;
  reason: string;
};
