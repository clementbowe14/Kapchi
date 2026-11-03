import { describe, expect, it } from "vitest";
import { serializeShippingCsv, SHIPPING_EXPORT_HEADERS } from "./csv.js";
import type { ShippingCsvRow } from "./types.js";

const row: ShippingCsvRow = {
  addressLine1: "123 Main St",
  addressLine2: "Unit 2",
  city: "Boston",
  company: "",
  country: "US",
  email: "customer@example.test",
  fullName: "Customer, Example",
  height: "2",
  kapchiReference: "KPS1-safe-reference",
  length: "10",
  note: "Kapchi shipping export v1",
  orderId: "KAP-1001",
  orderItemCount: "2",
  orderItems: "2 x Graduation Stole",
  phone: "6175550100",
  state: "MA",
  weightOunces: "12.5",
  width: "8",
  zip: "02108"
};

describe("Pirate Ship CSV v1", () => {
  it("emits deterministic UTF-8 BOM, quoted headers, values, and CRLF", () => {
    const first = serializeShippingCsv([row]);
    const second = serializeShippingCsv([row]);
    const text = first.bytes.toString("utf8");

    expect(first.sha256).toBe(second.sha256);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(text.startsWith(`\uFEFF${SHIPPING_EXPORT_HEADERS.map((header) => `"${header}"`).join(",")}\r\n`)).toBe(true);
    expect(text).toContain('"Customer, Example"');
    expect(text).toContain('"02108"');
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text).not.toContain("stripe");
  });

  it("enforces the one MiB serialized bound", () => {
    const oversized = Array.from({ length: 100 }, (_, index) => ({
      ...row,
      orderId: `KAP-${index}`,
      orderItems: "x".repeat(11_000)
    }));
    expect(() => serializeShippingCsv(oversized)).toThrowError(
      expect.objectContaining({ code: "EXPORT_FILE_TOO_LARGE" }),
    );
  });
});
