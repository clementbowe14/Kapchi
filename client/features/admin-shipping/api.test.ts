import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShippingExport,
  downloadShippingExport,
  parseShippingExportBatch,
  parseShippingExportPreflight,
} from "./api";

const batch = {
  allowedActions: ["download", "cancel", "confirm_shipment"],
  batchId: "44444444-4444-4444-8444-444444444444",
  createdAt: "2026-11-03T12:00:00.000Z",
  downloadPath: "/admin/shipping/export-batches/44444444-4444-4444-8444-444444444444/file",
  expiresAt: "2026-12-03T12:00:00.000Z",
  filename: "kapchi-pirate-ship-4444.csv",
  items: [{ orderId: "11111111-1111-4111-8111-111111111111", publicOrderNumber: "KAP-1042", shipmentId: "33333333-3333-4333-8333-333333333333" }],
  mappingVersion: 1,
  rowCount: 1,
  status: "prepared",
};

describe("admin shipping API", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("parses bounded preflight data without exposing arbitrary fields", () => {
    expect(parseShippingExportPreflight({ candidates: [{
      codes: [],
      eligible: true,
      existingPackage: { description: "Stole", heightInches: 2, lengthInches: 10, weightOunces: 12.5, widthInches: 8 },
      internalAddress: "must not escape parser",
      orderId: "11111111-1111-4111-8111-111111111111",
      publicOrderNumber: "KAP-1042",
      revision: 4,
    }] })).toEqual({ candidates: [expect.objectContaining({ eligible: true, existingPackage: expect.objectContaining({ weightOunces: "12.5" }) })] });
  });

  it("rejects a malformed batch action", () => {
    expect(() => parseShippingExportBatch({ ...batch, allowedActions: ["delete_history"] })).toThrow(/invalid/i);
  });

  it("sends a protected idempotency key and uses GET for an existing batch download", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(batch), { status: 201, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response("csv", { status: 200, headers: { "Content-Type": "text/csv" } }));
    const input = { orders: [{
      expectedRevision: 4,
      orderId: "11111111-1111-4111-8111-111111111111",
      package: { heightInches: 2, lengthInches: 10, weightOunces: 12.5, widthInches: 8 },
    }] };
    const created = await createShippingExport("token", input, "protected-key-1234", new AbortController().signal);
    await downloadShippingExport("token", created, new AbortController().signal);

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/admin/shipping/export-batches", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "Idempotency-Key": "protected-key-1234" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, `/api${batch.downloadPath}`, expect.objectContaining({
      headers: expect.objectContaining({ Accept: "text/csv" }),
    }));
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.method).toBeUndefined();
  });
});
