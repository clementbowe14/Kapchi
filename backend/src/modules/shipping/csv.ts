import { createHash } from "node:crypto";
import { stringify } from "csv-stringify/sync";
import { ShippingExportError } from "./errors.js";
import type { ShippingCsvRow } from "./types.js";

export const SHIPPING_EXPORT_HEADERS = [
  "Order ID",
  "Full Name",
  "Company",
  "Email",
  "Phone",
  "Address Line 1",
  "Address Line 2",
  "City",
  "State",
  "Zip",
  "Country",
  "Weight (Ounces)",
  "Length",
  "Width",
  "Height",
  "Order Items",
  "Order Item Count",
  "Note",
  "Kapchi Reference"
] as const;

const columns: Array<{ header: string; key: keyof ShippingCsvRow }> = [
  { header: "Order ID", key: "orderId" },
  { header: "Full Name", key: "fullName" },
  { header: "Company", key: "company" },
  { header: "Email", key: "email" },
  { header: "Phone", key: "phone" },
  { header: "Address Line 1", key: "addressLine1" },
  { header: "Address Line 2", key: "addressLine2" },
  { header: "City", key: "city" },
  { header: "State", key: "state" },
  { header: "Zip", key: "zip" },
  { header: "Country", key: "country" },
  { header: "Weight (Ounces)", key: "weightOunces" },
  { header: "Length", key: "length" },
  { header: "Width", key: "width" },
  { header: "Height", key: "height" },
  { header: "Order Items", key: "orderItems" },
  { header: "Order Item Count", key: "orderItemCount" },
  { header: "Note", key: "note" },
  { header: "Kapchi Reference", key: "kapchiReference" }
];

export function serializeShippingCsv(rows: ShippingCsvRow[]) {
  const body = stringify(rows, {
    bom: true,
    columns,
    header: true,
    quoted: true,
    record_delimiter: "windows"
  });
  const bytes = Buffer.from(body, "utf8");
  if (bytes.byteLength > 1_048_576) {
    throw new ShippingExportError(
      "EXPORT_FILE_TOO_LARGE",
      "The shipping export exceeds the maximum file size.",
      400,
    );
  }
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

export function shippingRowHash(row: ShippingCsvRow) {
  const canonical = Object.fromEntries(
    Object.entries(row).sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
