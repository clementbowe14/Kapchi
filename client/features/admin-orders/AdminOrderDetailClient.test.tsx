import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminOrderDetailClient } from "./AdminOrderDetailClient";
import { createAdminOrderDetail } from "./test-fixtures";

const authState = vi.hoisted(() => ({
  getToken: vi.fn(),
  isLoaded: true,
  isSignedIn: true,
  userId: "admin-1" as string | null,
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => authState }));

function json(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", ...headers },
    status,
  });
}

const emptyTimeline = { entries: [], nextCursor: null };

function requestPath(input: RequestInfo | URL) {
  return new URL(String(input), "http://localhost").pathname;
}

describe("AdminOrderDetailClient integration", () => {
  beforeEach(() => {
    authState.getToken.mockReset();
    authState.getToken.mockResolvedValue("admin-token");
    authState.isLoaded = true;
    authState.isSignedIn = true;
    authState.userId = "admin-1";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      requestPath(input).endsWith("/timeline") ? json(emptyTimeline) : json(createAdminOrderDetail())));
  });

  it("renders stored production selections without exposing private identifiers", async () => {
    render(
      <AdminOrderDetailClient
        orderId="11111111-1111-4111-8111-111111111111"
        returnHref="/admin/orders?status=in_production"
      />,
    );

    expect(await screen.findByText("Classic graduation stole")).toBeInTheDocument();
    expect(screen.getByText(/Fabric: Royal blue/)).toBeInTheDocument();
    expect(screen.getByText("Text (long) + Image + Trim")).toBeInTheDocument();
    expect(screen.getByText("Class of 2026 / Maya")).toBeInTheDocument();
    expect(screen.getByText("Garamond")).toBeInTheDocument();
    expect(screen.getByText("Left panel")).toBeInTheDocument();
    expect(screen.getByText("1 inch / Gold")).toBeInTheDocument();
    expect(screen.getByText("Standard: 5-7 business days")).toBeInTheDocument();
    expect(screen.getByText("Match the approved customer proof.")).toBeInTheDocument();
    expect(screen.queryByText("asset-private")).not.toBeInTheDocument();
    expect(screen.queryByText("never-render")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to ongoing orders" })).toHaveAttribute(
      "href",
      "/admin/orders?status=in_production",
    );
    expect(screen.getByLabelText("Order status: In Production")).toBeInTheDocument();
    expect(screen.getByLabelText("Payment status: Paid")).toBeInTheDocument();
    expect(screen.getByLabelText("Fulfillment status: In Progress")).toBeInTheDocument();
  });

  it("does not request an order for a signed-out visitor", () => {
    authState.isSignedIn = false;
    authState.userId = null;
    render(
      <AdminOrderDetailClient
        orderId="11111111-1111-4111-8111-111111111111"
        returnHref="/admin/orders"
      />,
    );

    expect(screen.getByRole("heading", { name: "Admin sign-in required" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replays one unauthorized request and then expires the session", async () => {
    vi.mocked(fetch).mockResolvedValue(json({ error: "UNAUTHORIZED" }, 401));
    render(
      <AdminOrderDetailClient
        orderId="11111111-1111-4111-8111-111111111111"
        returnHref="/admin/orders"
      />,
    );

    expect(await screen.findByRole("heading", { name: "Session expired" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("shows a forbidden state without rendering order data", async () => {
    vi.mocked(fetch).mockResolvedValue(json({ error: "FORBIDDEN" }, 403));
    render(
      <AdminOrderDetailClient
        orderId="11111111-1111-4111-8111-111111111111"
        returnHref="/admin/orders"
      />,
    );

    expect(await screen.findByRole("heading", { name: "Admin access required" })).toBeInTheDocument();
    expect(screen.queryByText("Classic graduation stole")).not.toBeInTheDocument();
  });

  it("recovers from a temporary detail failure", async () => {
    const user = userEvent.setup();
    let detailAttempts = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (requestPath(input).endsWith("/timeline")) return json(emptyTimeline);
      detailAttempts += 1;
      return detailAttempts === 1
        ? json({ error: "ADMIN_ORDERS_UNAVAILABLE" }, 503, { "Retry-After": "4" })
        : json(createAdminOrderDetail());
    });
    render(
      <AdminOrderDetailClient
        orderId="11111111-1111-4111-8111-111111111111"
        returnHref="/admin/orders"
      />,
    );

    expect(await screen.findByRole("heading", { name: "Order unavailable" })).toBeInTheDocument();
    expect(screen.getByText(/Try again in about 4 seconds/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Classic graduation stole")).toBeInTheDocument();
  });

  it("clears the prior order when identity changes and token retrieval fails", async () => {
    const view = render(
      <AdminOrderDetailClient
        orderId="11111111-1111-4111-8111-111111111111"
        returnHref="/admin/orders"
      />,
    );
    expect(await screen.findByText("Classic graduation stole")).toBeInTheDocument();

    authState.userId = "admin-2";
    authState.getToken.mockRejectedValueOnce(new Error("Clerk unavailable"));
    view.rerender(
      <AdminOrderDetailClient
        orderId="11111111-1111-4111-8111-111111111111"
        returnHref="/admin/orders"
      />,
    );

    expect(screen.queryByText("Classic graduation stole")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Session expired" })).toBeInTheDocument();
  });

  it("handles an unknown order without exposing backend response copy", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      error: "ORDER_NOT_FOUND",
      message: "sensitive backend detail",
    }), { status: 404 }));
    render(
      <AdminOrderDetailClient
        orderId="11111111-1111-4111-8111-111111111111"
        returnHref="/admin/orders"
      />,
    );
    expect(await screen.findByRole("heading", { name: "Order not found" })).toBeInTheDocument();
    expect(screen.queryByText("sensitive backend detail")).not.toBeInTheDocument();
  });

  it("shows a retryable error for malformed detail data", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ id: "incomplete" }), { status: 200 }));
    render(
      <AdminOrderDetailClient
        orderId="11111111-1111-4111-8111-111111111111"
        returnHref="/admin/orders"
      />,
    );

    expect(await screen.findByRole("heading", { name: "Order unavailable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("submits the exact lifecycle intent and verifies fresh detail and history", async () => {
    const user = userEvent.setup();
    let current = createAdminOrderDetail();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = requestPath(input);
      if (init?.method === "POST") {
        current = createAdminOrderDetail({
          fulfillmentStatus: "ready_to_ship",
          fulfillments: [{ ...current.fulfillments[0], status: "ready_to_ship" }],
          revision: 3,
          status: "ready_to_ship",
        });
        return json({
          command: "mark_ready_to_ship",
          fulfillmentStatus: "ready_to_ship",
          orderId: current.id,
          orderStatus: "ready_to_ship",
          paymentStatus: "paid",
          replayed: false,
          revision: 3,
          transitionedAt: "2026-11-02T18:00:00.000Z",
        });
      }
      return path.endsWith("/timeline") ? json(emptyTimeline) : json(current);
    });
    render(<AdminOrderDetailClient orderId={current.id} returnHref="/admin/orders" />);

    await user.click(await screen.findByRole("button", { name: "Mark ready to ship" }));
    const dialog = screen.getByRole("dialog", { name: "Mark ready to ship" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await user.type(screen.getByLabelText("Internal audit reason (optional)"), "Production complete");
    await user.click(within(dialog).getByRole("button", { name: "Mark ready to ship" }));

    expect(await screen.findByText("Mark ready to ship accepted.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe(`/api/admin/orders/${current.id}/actions/mark-ready-to-ship`);
    expect(post?.[1]?.headers).toEqual(expect.objectContaining({
      Authorization: "Bearer admin-token",
      "Idempotency-Key": expect.stringMatching(/^[0-9a-f-]{36}$/i),
    }));
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ expectedRevision: 2, reason: "Production complete" });
  });

  it("validates shipment fields without dispatching a mutation", async () => {
    const user = userEvent.setup();
    const base = createAdminOrderDetail();
    const ready = createAdminOrderDetail({
      fulfillmentStatus: "ready_to_ship",
      fulfillments: [{ ...base.fulfillments[0], status: "ready_to_ship" }],
      status: "ready_to_ship",
    });
    vi.mocked(fetch).mockImplementation(async (input) => requestPath(input).endsWith("/timeline") ? json(emptyTimeline) : json(ready));
    render(<AdminOrderDetailClient orderId={ready.id} returnHref="/admin/orders" />);

    await user.click(await screen.findByRole("button", { name: "Confirm shipment" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm shipment" }));
    expect(await screen.findByText("Carrier is required.")).toBeInTheDocument();
    expect(screen.getByText("Tracking number is required.")).toBeInTheDocument();
    expect(screen.getByLabelText("Carrier")).toHaveAttribute("aria-invalid", "true");
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("binds tracking confirmation to the shipment recovered from an export", async () => {
    const user = userEvent.setup();
    const shipmentId = "44444444-4444-4444-8444-444444444444";
    const base = createAdminOrderDetail();
    let current = createAdminOrderDetail({
      fulfillmentStatus: "ready_to_ship",
      fulfillments: [{ ...base.fulfillments[0], status: "ready_to_ship" }],
      shipments: [{ carrier: null, carrierService: null, id: shipmentId, shippedAt: null, shipmentNumber: 1, status: "label_pending", trackingNumber: null, trackingUrl: null }],
      status: "ready_to_ship",
    });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = requestPath(input);
      if (init?.method === "POST" && path.endsWith("/confirm-shipment")) {
        current = createAdminOrderDetail({ ...current, fulfillmentStatus: "shipped", revision: 3, status: "shipped" });
        return json({
          command: "confirm_shipment", fulfillmentStatus: "shipped", orderId: current.id,
          orderStatus: "shipped", paymentStatus: "paid", replayed: false, revision: 3,
          shipment: { carrier: "USPS", carrierService: null, id: shipmentId, shippedAt: "2026-11-03T12:00:00.000Z", trackingNumber: "9400111899", trackingUrl: null },
          transitionedAt: "2026-11-03T12:00:00.000Z",
        });
      }
      return path.endsWith("/timeline") ? json(emptyTimeline) : json(current);
    });
    render(<AdminOrderDetailClient expectedShipmentId={shipmentId} orderId={current.id} returnHref="/admin/orders" />);

    await user.click(await screen.findByRole("button", { name: "Confirm shipment" }));
    expect(screen.getByLabelText("Shipment from export")).toHaveValue(shipmentId);
    expect(screen.getByLabelText("Shipment from export")).toBeDisabled();
    await user.type(screen.getByLabelText("Carrier"), "USPS");
    await user.type(screen.getByLabelText("Tracking number"), "9400111899");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm shipment" }));

    const post = vi.mocked(fetch).mock.calls.find(([input, init]) => requestPath(input).endsWith("/confirm-shipment") && init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      carrier: "USPS", expectedRevision: 2, shipmentId, trackingNumber: "9400111899",
    });
  });

  it("submits a guarded U.S. address correction before re-export", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = requestPath(input);
      if (init?.method === "POST" && path.endsWith("/correct-shipping-address")) return json({ orderId: "11111111-1111-4111-8111-111111111111", replayed: false, revision: 3 });
      return path.endsWith("/timeline") ? json(emptyTimeline) : json(createAdminOrderDetail());
    });
    render(<AdminOrderDetailClient orderId="11111111-1111-4111-8111-111111111111" returnHref="/admin/orders" />);

    await user.click(await screen.findByRole("button", { name: "Correct address" }));
    const dialog = screen.getByRole("dialog", { name: "Correct shipping address" });
    await user.clear(within(dialog).getByLabelText("ZIP code"));
    await user.type(within(dialog).getByLabelText("ZIP code"), "01234");
    await user.type(within(dialog).getByLabelText("Internal correction reason"), "Customer confirmed corrected ZIP");
    await user.click(within(dialog).getByText(/I verified this address/));
    await user.click(within(dialog).getByRole("button", { name: "Save corrected address" }));

    const post = vi.mocked(fetch).mock.calls.find(([input, init]) => requestPath(input).endsWith("/correct-shipping-address") && init?.method === "POST");
    expect(post?.[1]?.headers).toEqual(expect.objectContaining({ "Idempotency-Key": expect.any(String) }));
    expect(JSON.parse(String(post?.[1]?.body))).toEqual(expect.objectContaining({
      address: expect.objectContaining({ country: "US", postalCode: "01234", state: "NY" }),
      expectedRevision: 2,
      intent: "correct_shipping_address",
      reason: "Customer confirmed corrected ZIP",
    }));
  });

  it("adds a trimmed internal note and clears it only after verification", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = requestPath(input);
      if (init?.method === "POST" && path.endsWith("/notes")) return json({
        body: "Production proof approved",
        channel: "internal_note",
        createdAt: "2026-11-02T18:00:00.000Z",
        direction: "internal",
        failedAt: null,
        id: "note-1",
        senderType: "admin",
        sentAt: "2026-11-02T18:00:00.000Z",
        status: "sent",
        subject: null,
      }, 201);
      return path.endsWith("/timeline") ? json(emptyTimeline) : json(createAdminOrderDetail());
    });
    render(<AdminOrderDetailClient orderId="11111111-1111-4111-8111-111111111111" returnHref="/admin/orders" />);
    const note = await screen.findByLabelText("Note");
    await user.type(note, "  Production proof approved  ");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    expect(await screen.findByText("Internal note added.")).toBeInTheDocument();
    expect(note).toHaveValue("");
    const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ body: "Production proof approved" });
  });

  it("pauses mutations when an accepted update cannot be verified and recovers with a read-only refresh", async () => {
    const user = userEvent.setup();
    let current = createAdminOrderDetail();
    let failVerificationDetail = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = requestPath(input);
      if (init?.method === "POST") {
        current = createAdminOrderDetail({
          fulfillmentStatus: "ready_to_ship",
          fulfillments: [{ ...current.fulfillments[0], status: "ready_to_ship" }],
          revision: 3,
          status: "ready_to_ship",
        });
        failVerificationDetail = true;
        return json({ command: "mark_ready_to_ship", fulfillmentStatus: "ready_to_ship", orderId: current.id, orderStatus: "ready_to_ship", paymentStatus: "paid", replayed: false, revision: 3, transitionedAt: "2026-11-02T18:00:00.000Z" });
      }
      if (path.endsWith("/timeline")) return json(emptyTimeline);
      if (failVerificationDetail) {
        failVerificationDetail = false;
        return json({ error: "ADMIN_ORDERS_UNAVAILABLE" }, 503);
      }
      return json(current);
    });
    render(<AdminOrderDetailClient orderId={current.id} returnHref="/admin/orders" />);

    await user.click(await screen.findByRole("button", { name: "Mark ready to ship" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Mark ready to ship" }));
    expect((await screen.findAllByText("Update accepted; latest state unavailable")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await screen.findByText("The update was accepted.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm shipment" })).toBeEnabled();
  });
});
