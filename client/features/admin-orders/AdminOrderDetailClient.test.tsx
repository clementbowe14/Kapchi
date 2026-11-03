import { render, screen } from "@testing-library/react";
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

describe("AdminOrderDetailClient integration", () => {
  beforeEach(() => {
    authState.getToken.mockReset();
    authState.getToken.mockResolvedValue("admin-token");
    authState.isLoaded = true;
    authState.isSignedIn = true;
    authState.userId = "admin-1";
    vi.stubGlobal("fetch", vi.fn());
  });

  it("renders stored production selections without exposing private identifiers", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(createAdminOrderDetail()), { status: 200 }));
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
    expect(fetch).toHaveBeenCalledTimes(2);
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
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ error: "ADMIN_ORDERS_UNAVAILABLE" }, 503, { "Retry-After": "4" }))
      .mockResolvedValueOnce(json(createAdminOrderDetail()));
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
    vi.mocked(fetch).mockResolvedValue(json(createAdminOrderDetail()));
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
});
