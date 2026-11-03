import { describe, expect, it } from "vitest";
import { createAdminOrderDetail } from "./test-fixtures";
import { decideOrderAction, validateNote, validateReason, validateShipment } from "./order-workflow";

describe("admin order action eligibility", () => {
  it.each([
    ["paid", undefined, "start_production"],
    ["paid", "queued", "start_production"],
    ["in_production", "in_progress", "mark_ready_to_ship"],
    ["ready_to_ship", "ready_to_ship", "confirm_shipment"],
  ] as const)("selects the exact action for %s / %s", (status, fulfillment, action) => {
    const base = createAdminOrderDetail();
    const fulfillments = fulfillment === undefined ? [] : [{ ...base.fulfillments[0], status: fulfillment }];
    expect(decideOrderAction(createAdminOrderDetail({ status, fulfillmentStatus: fulfillment ?? "not_started", fulfillments }))).toEqual({ action, explanation: "" });
  });

  it("blocks every action without a settled payment timestamp", () => {
    expect(decideOrderAction(createAdminOrderDetail({ paidAt: null })).explanation).toMatch(/Payment must be confirmed/);
    expect(decideOrderAction(createAdminOrderDetail({ paymentStatus: "failed" })).action).toBeNull();
  });

  it("requires the correct address snapshot for each stage", () => {
    expect(decideOrderAction(createAdminOrderDetail({ status: "paid", shipping: { address: null, name: null } })).explanation).toMatch(/shipping address/);
    expect(decideOrderAction(createAdminOrderDetail({ fulfillments: [{ ...createAdminOrderDetail().fulfillments[0], shippingAddressSnapshot: null }] })).explanation).toMatch(/shipping address/);
  });

  it("does not offer shipment confirmation when one is already active", () => {
    const base = createAdminOrderDetail();
    const order = createAdminOrderDetail({
      status: "ready_to_ship",
      fulfillmentStatus: "ready_to_ship",
      fulfillments: [{ ...base.fulfillments[0], status: "ready_to_ship" }],
      shipments: [{ carrier: "USPS", carrierService: null, id: "shipment-1", shipmentNumber: 1, shippedAt: "2026-11-02T18:00:00.000Z", status: "in_transit", trackingNumber: "9400", trackingUrl: null }],
    });
    expect(decideOrderAction(order)).toEqual({ action: null, explanation: "Shipment is already recorded for this order." });
  });

  it.each(["cancelled", "completed", "refunded"])("offers no action for terminal state %s", (status) => {
    expect(decideOrderAction(createAdminOrderDetail({ status }))).toEqual({ action: null, explanation: "No fulfillment action is available for this order." });
  });
});

describe("admin order form validation", () => {
  it("trims and bounds notes and reasons", () => {
    expect(validateNote("   ")).toMatch(/Enter/);
    expect(validateNote(` ${"a".repeat(10_001)} `)).toMatch(/10,000/);
    expect(validateReason("  ")).toBeNull();
    expect(validateReason("ab")).toMatch(/at least 3/);
    expect(validateReason("valid reason")).toBeNull();
  });

  it("rejects missing, oversized, and control-character shipment values", () => {
    expect(validateShipment({ carrier: "", carrierService: "", reason: "", trackingNumber: "" })).toMatchObject({ carrier: expect.any(String), trackingNumber: expect.any(String) });
    const controlErrors = validateShipment({ carrier: "USP\nS", carrierService: "", reason: "", trackingNumber: "9400" });
    const lengthErrors = validateShipment({ carrier: "USPS", carrierService: "x".repeat(101), reason: "", trackingNumber: "9400" });
    expect(controlErrors.carrier).toMatch(/control/);
    expect(lengthErrors.carrierService).toMatch(/100/);
  });
});
