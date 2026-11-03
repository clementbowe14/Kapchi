import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminOrderSummary } from "@/features/admin-orders/test-fixtures";
import { ShippingExportWorkflow } from "./ShippingExportWorkflow";

const auth = vi.hoisted(() => ({ getToken: vi.fn(), userId: "admin-1" }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));

const candidate = {
  codes: [],
  eligible: true,
  existingPackage: null,
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderNumber: "KAP-1042",
  revision: 4,
};
const batch = {
  allowedActions: ["download", "cancel", "confirm_shipment"],
  batchId: "44444444-4444-4444-8444-444444444444",
  createdAt: "2026-11-03T12:00:00.000Z",
  downloadPath: "/admin/shipping/export-batches/44444444-4444-4444-8444-444444444444/file",
  expiresAt: "2026-12-03T12:00:00.000Z",
  filename: "kapchi-export.csv",
  items: [{ orderId: candidate.orderId, publicOrderNumber: candidate.publicOrderNumber, shipmentId: "33333333-3333-4333-8333-333333333333" }],
  mappingVersion: 1,
  rowCount: 1,
  status: "prepared",
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("ShippingExportWorkflow", () => {
  beforeEach(() => {
    auth.getToken.mockReset();
    auth.getToken.mockResolvedValue("admin-token");
    vi.stubGlobal("fetch", vi.fn());
  });

  it("recovers an ambiguous create with the identical payload and key", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/export-candidates")) return json({ candidates: [candidate] });
      if (url.endsWith("/export-batches") && init?.method === "POST") {
        const createCalls = vi.mocked(fetch).mock.calls.filter(([request, requestInit]) => String(request).endsWith("/export-batches") && requestInit?.method === "POST");
        if (createCalls.length === 1) throw new TypeError("connection reset after commit");
        return json(batch);
      }
      throw new Error(`Unexpected request ${url}`);
    });

    render(<ShippingExportWorkflow
      orders={[createAdminOrderSummary({ ...candidate, fulfillmentStatus: "ready_to_ship", paymentStatus: "paid", status: "ready_to_ship" })]}
      onAuthorizationFailure={vi.fn()}
      onClose={vi.fn()}
      onCreated={created}
    />);
    await screen.findByText("Eligible");
    await user.type(screen.getByLabelText("KAP-1042 Weight (oz)"), "12.5");
    await user.type(screen.getByLabelText("KAP-1042 Length (in)"), "10");
    await user.type(screen.getByLabelText("KAP-1042 Width (in)"), "8");
    await user.type(screen.getByLabelText("KAP-1042 Height (in)"), "2");
    await user.click(screen.getByRole("button", { name: "Create export (1)" }));
    expect(await screen.findByRole("button", { name: "Recover export" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Recover export" }));
    expect(await screen.findByText("Export prepared")).toBeInTheDocument();

    const calls = vi.mocked(fetch).mock.calls.filter(([request, init]) => String(request).endsWith("/export-batches") && init?.method === "POST");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]?.body).toBe(calls[1]?.[1]?.body);
    expect(new Headers(calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe(new Headers(calls[1]?.[1]?.headers).get("Idempotency-Key"));
    await waitFor(() => expect(created).toHaveBeenCalledWith(expect.objectContaining({ batchId: batch.batchId })));
  });
});
