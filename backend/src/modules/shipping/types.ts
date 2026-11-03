export type ShippingActor = {
  authSubject: string;
  userId: string;
};

export type PackageInput = {
  description?: string;
  heightInches: number;
  lengthInches: number;
  weightOunces: number;
  widthInches: number;
};

export type ExportOrderInput = {
  expectedRevision: number;
  orderId: string;
  package: PackageInput;
};

export type ShippingAddress = {
  city: string;
  country: "US";
  line1: string;
  line2?: string;
  postalCode: string;
  state: string;
};

export type ShippingCsvRow = {
  addressLine1: string;
  addressLine2: string;
  city: string;
  company: string;
  country: string;
  email: string;
  fullName: string;
  height: string;
  kapchiReference: string;
  length: string;
  note: string;
  orderId: string;
  orderItemCount: string;
  orderItems: string;
  phone: string;
  state: string;
  weightOunces: string;
  width: string;
  zip: string;
};

export type ExportBatchSummary = {
  allowedActions: string[];
  createdAt: string;
  expiresAt: string;
  filename: string;
  id: string;
  issuedCount: number;
  mappingVersion: 1;
  orders: Array<{ orderId: string; publicOrderNumber: string; shipmentId: string }>;
  rowCount: number;
  status: "prepared" | "cancelled" | "expired";
};

export type AddressCorrectionInput = {
  expectedRevision: number;
  intent: "correct_shipping_address";
  name: string;
  reason: string;
  address: ShippingAddress;
};
