import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminOrdersDashboard } from "./AdminOrdersDashboard";
import { createAdminOrderPage, createAdminOrderSummary } from "./test-fixtures";

const authState = vi.hoisted(() => ({
  getToken: vi.fn(),
  isLoaded: true,
  isSignedIn: true,
  userId: "admin-1" as string | null,
}));
const router = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => authState }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

function json(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", ...headers },
    status,
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

describe("AdminOrdersDashboard integration", () => {
  beforeEach(() => {
    authState.getToken.mockReset();
    authState.getToken.mockResolvedValue("admin-token");
    authState.isLoaded = true;
    authState.isSignedIn = true;
    authState.userId = "admin-1";
    router.replace.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("loads the ongoing queue with a bearer token and renders operational data", async () => {
    vi.mocked(fetch).mockResolvedValue(json(createAdminOrderPage()));
    render(<AdminOrdersDashboard />);

    expect(await screen.findAllByText("KAP-1042")).not.toHaveLength(0);
    expect(screen.getAllByText("Maya Quispe")).not.toHaveLength(0);
    expect(screen.getAllByText("In Production")).not.toHaveLength(0);
    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/orders?lifecycle=ongoing&limit=25&sort=created_desc",
      expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer admin-token" },
      }),
    );
  });

  it("applies an ongoing status filter and oldest-first sort", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValue(json(createAdminOrderPage()));
    render(<AdminOrdersDashboard />);
    await screen.findAllByText("KAP-1042");

    await user.selectOptions(screen.getByLabelText("Order status"), "in_production");
    await user.selectOptions(screen.getByLabelText("Date order"), "created_asc");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(
      "/api/admin/orders?lifecycle=ongoing&limit=25&sort=created_asc&orderStatus=in_production",
      expect.any(Object),
    ));
    expect(router.replace).toHaveBeenCalledWith(
      "/admin/orders?status=in_production&sort=created_asc",
      { scroll: false },
    );
    expect(screen.queryByRole("option", { name: "Completed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Cancelled" })).not.toBeInTheDocument();
  });

  it("does not request order data for a signed-out visitor", () => {
    authState.isSignedIn = false;
    authState.userId = null;
    render(<AdminOrdersDashboard />);
    expect(screen.getByRole("heading", { name: "Admin sign-in required" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears protected rows when a refresh is forbidden", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(createAdminOrderPage()))
      .mockResolvedValueOnce(json({ error: "FORBIDDEN" }, 403));
    render(<AdminOrdersDashboard />);
    expect(await screen.findAllByText("Maya Quispe")).not.toHaveLength(0);

    await user.selectOptions(screen.getByLabelText("Date order"), "created_asc");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(await screen.findByRole("heading", { name: "Admin access required" })).toBeInTheDocument();
    expect(screen.queryByText("Maya Quispe")).not.toBeInTheDocument();
  });

  it("replays one unauthorized request and then shows an expired session", async () => {
    vi.mocked(fetch).mockResolvedValue(json({ error: "UNAUTHORIZED" }, 401));
    render(<AdminOrdersDashboard />);

    expect(await screen.findByRole("heading", { name: "Session expired" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(authState.getToken).toHaveBeenNthCalledWith(2, { skipCache: true });
  });

  it("shows retry timing for a temporary failure and recovers", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(
        { error: "ADMIN_ORDERS_UNAVAILABLE" },
        503,
        { "Retry-After": "12" },
      ))
      .mockResolvedValueOnce(json(createAdminOrderPage()));
    render(<AdminOrdersDashboard />);

    expect(await screen.findByText(/Try again in about 12 seconds/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findAllByText("KAP-1042")).not.toHaveLength(0);
  });

  it("treats a malformed success response as unavailable", async () => {
    vi.mocked(fetch).mockResolvedValue(json({ nextCursor: null, orders: [{ id: "only-id" }] }));
    render(<AdminOrdersDashboard />);

    expect(await screen.findByRole("heading", { name: "Orders unavailable" })).toBeInTheDocument();
  });

  it("distinguishes an empty ongoing queue from an empty filtered result", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(createAdminOrderPage({ orders: [] })))
      .mockResolvedValueOnce(json(createAdminOrderPage({ orders: [] })));
    render(<AdminOrdersDashboard />);

    expect(await screen.findByRole("heading", { name: "No ongoing orders" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Order status"), "paid");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(await screen.findByRole("heading", { name: "No orders match these filters" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
  });

  it("hides prior customer data immediately when the identity changes", async () => {
    const pending = deferredResponse();
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(createAdminOrderPage()))
      .mockReturnValueOnce(pending.promise);
    const view = render(<AdminOrdersDashboard />);
    expect(await screen.findAllByText("Maya Quispe")).not.toHaveLength(0);

    authState.userId = "admin-2";
    view.rerender(<AdminOrdersDashboard />);
    expect(screen.queryByText("Maya Quispe")).not.toBeInTheDocument();
    expect(screen.getByText("Loading ongoing orders")).toBeInTheDocument();
    await act(async () => pending.resolve(json(createAdminOrderPage())));
  });

  it("clears protected rows when the user signs out", async () => {
    vi.mocked(fetch).mockResolvedValue(json(createAdminOrderPage()));
    const view = render(<AdminOrdersDashboard />);
    expect(await screen.findAllByText("Maya Quispe")).not.toHaveLength(0);

    authState.isSignedIn = false;
    authState.userId = null;
    view.rerender(<AdminOrdersDashboard />);

    expect(screen.getByRole("heading", { name: "Admin sign-in required" })).toBeInTheDocument();
    expect(screen.queryByText("Maya Quispe")).not.toBeInTheDocument();
  });

  it("clears protected rows when Clerk can no longer provide a token", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValue(json(createAdminOrderPage()));
    render(<AdminOrdersDashboard />);
    expect(await screen.findAllByText("Maya Quispe")).not.toHaveLength(0);

    authState.getToken.mockRejectedValueOnce(new Error("Clerk unavailable"));
    await user.selectOptions(screen.getByLabelText("Date order"), "created_asc");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(await screen.findByRole("heading", { name: "Session expired" })).toBeInTheDocument();
    expect(screen.queryByText("Maya Quispe")).not.toBeInTheDocument();
  });

  it("appends and replaces duplicate cursor rows", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(createAdminOrderPage({ nextCursor: "cursor-1" })))
      .mockResolvedValueOnce(json(createAdminOrderPage({
        orders: [
          createAdminOrderSummary({ customer: { email: null, name: "Updated customer", phone: null, preferredContactMethod: null } }),
          createAdminOrderSummary({ id: "33333333-3333-4333-8333-333333333333", publicOrderNumber: "KAP-1043" }),
        ],
      })));
    render(<AdminOrdersDashboard />);
    await screen.findAllByText("KAP-1042");
    await user.click(screen.getByRole("button", { name: "Load more orders" }));
    expect(await screen.findAllByText("KAP-1043")).not.toHaveLength(0);
    expect(screen.getAllByText("Updated customer")).not.toHaveLength(0);
    expect(screen.getAllByText("Maya Quispe")).toHaveLength(2);
  });

  it("ignores a delayed append response after filters change", async () => {
    const user = userEvent.setup();
    const delayedAppend = deferredResponse();
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(createAdminOrderPage({ nextCursor: "cursor-1" })))
      .mockReturnValueOnce(delayedAppend.promise)
      .mockResolvedValueOnce(json(createAdminOrderPage({
        orders: [createAdminOrderSummary({
          id: "33333333-3333-4333-8333-333333333333",
          publicOrderNumber: "KAP-FILTERED",
          status: "paid",
        })],
      })));
    render(<AdminOrdersDashboard />);
    await screen.findAllByText("KAP-1042");

    await user.click(screen.getByRole("button", { name: "Load more orders" }));
    await user.selectOptions(screen.getByLabelText("Order status"), "paid");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(await screen.findAllByText("KAP-FILTERED")).not.toHaveLength(0);

    await act(async () => delayedAppend.resolve(json(createAdminOrderPage({
      orders: [createAdminOrderSummary({
        id: "44444444-4444-4444-8444-444444444444",
        publicOrderNumber: "KAP-STALE",
      })],
    }))));
    expect(screen.queryByText("KAP-STALE")).not.toBeInTheDocument();
    expect(screen.getAllByText("KAP-FILTERED")).not.toHaveLength(0);
  });

  it("ignores a delayed append response after authentication changes", async () => {
    const user = userEvent.setup();
    const delayedAppend = deferredResponse();
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(createAdminOrderPage({ nextCursor: "cursor-1" })))
      .mockReturnValueOnce(delayedAppend.promise);
    const view = render(<AdminOrdersDashboard />);
    await screen.findAllByText("KAP-1042");

    await user.click(screen.getByRole("button", { name: "Load more orders" }));
    authState.isSignedIn = false;
    authState.userId = null;
    view.rerender(<AdminOrdersDashboard />);
    await act(async () => delayedAppend.resolve(json(createAdminOrderPage({
      orders: [createAdminOrderSummary({
        id: "44444444-4444-4444-8444-444444444444",
        publicOrderNumber: "KAP-STALE",
      })],
    }))));

    expect(screen.getByRole("heading", { name: "Admin sign-in required" })).toBeInTheDocument();
    expect(screen.queryByText("KAP-STALE")).not.toBeInTheDocument();
  });

  it("aborts an append request when the dashboard unmounts", async () => {
    const user = userEvent.setup();
    const delayedAppend = deferredResponse();
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(createAdminOrderPage({ nextCursor: "cursor-1" })))
      .mockReturnValueOnce(delayedAppend.promise);
    const view = render(<AdminOrdersDashboard />);
    await screen.findAllByText("KAP-1042");

    await user.click(screen.getByRole("button", { name: "Load more orders" }));
    const requestSignal = vi.mocked(fetch).mock.calls[1]?.[1]?.signal;
    view.unmount();
    expect(requestSignal?.aborted).toBe(true);
    await act(async () => delayedAppend.resolve(json(createAdminOrderPage())));
  });

  it("prevents concurrent append requests while a page is loading", async () => {
    const user = userEvent.setup();
    const delayedAppend = deferredResponse();
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(createAdminOrderPage({ nextCursor: "cursor-1" })))
      .mockReturnValueOnce(delayedAppend.promise);
    render(<AdminOrdersDashboard />);
    await screen.findAllByText("KAP-1042");

    const loadMore = screen.getByRole("button", { name: "Load more orders" });
    await user.click(loadMore);
    expect(screen.getByRole("button", { name: "Loading..." })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Loading..." }));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => delayedAppend.resolve(json(createAdminOrderPage())));
  });

  it("preserves rows and retries the same cursor after append failure", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(createAdminOrderPage({ nextCursor: "cursor-1" })))
      .mockResolvedValueOnce(json(
        { error: "ADMIN_ORDERS_UNAVAILABLE" },
        503,
        { "Retry-After": "6" },
      ))
      .mockResolvedValueOnce(json(createAdminOrderPage({
        orders: [createAdminOrderSummary({
          id: "33333333-3333-4333-8333-333333333333",
          publicOrderNumber: "KAP-1043",
        })],
      })));
    render(<AdminOrdersDashboard />);
    await screen.findAllByText("KAP-1042");

    await user.click(screen.getByRole("button", { name: "Load more orders" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Existing rows are unchanged");
    expect(screen.getByRole("alert")).toHaveTextContent("Try again in about 6 seconds");
    expect(screen.getAllByText("KAP-1042")).not.toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Retry loading more" }));
    expect(await screen.findAllByText("KAP-1043")).not.toHaveLength(0);
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringContaining("cursor=cursor-1"),
      expect.any(Object),
    );
  });

  it("shares eligible shipping selection across desktop and mobile renderers", async () => {
    const user = userEvent.setup();
    const ready = createAdminOrderSummary({
      fulfillmentStatus: "ready_to_ship",
      paymentStatus: "paid",
      revision: 4,
      status: "ready_to_ship",
    });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/admin/orders?")) return json(createAdminOrderPage({ orders: [ready] }));
      if (url.endsWith("/admin/shipping/export-candidates") && init?.method === "POST") {
        return json({ candidates: [{
          codes: [], eligible: true, existingPackage: null, orderId: ready.id,
          publicOrderNumber: ready.publicOrderNumber, revision: ready.revision,
        }] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<AdminOrdersDashboard />);
    const selectors = await screen.findAllByLabelText(`Select ${ready.publicOrderNumber} for shipping export`);
    await user.click(selectors[0]);
    expect(selectors).toHaveLength(2);
    expect(selectors.every((checkbox) => (checkbox as HTMLInputElement).checked)).toBe(true);
    await user.click(screen.getByRole("button", { name: "Prepare export (1)" }));
    expect(await screen.findByRole("dialog", { name: "Prepare Pirate Ship export" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/shipping/export-candidates",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("clears the protected queue when shipping preflight cannot refresh authorization", async () => {
    const user = userEvent.setup();
    const ready = createAdminOrderSummary({ fulfillmentStatus: "ready_to_ship", paymentStatus: "paid", status: "ready_to_ship" });
    vi.mocked(fetch).mockImplementation(async (input) => String(input).includes("/admin/orders?")
      ? json(createAdminOrderPage({ orders: [ready] }))
      : json({ error: "UNAUTHORIZED" }, 401));
    render(<AdminOrdersDashboard />);
    const selectors = await screen.findAllByLabelText(`Select ${ready.publicOrderNumber} for shipping export`);
    await user.click(selectors[0]);
    await user.click(screen.getByRole("button", { name: "Prepare export (1)" }));

    expect(await screen.findByRole("heading", { name: "Session expired" })).toBeInTheDocument();
    expect(screen.queryByText(ready.publicOrderNumber)).not.toBeInTheDocument();
  });
});
