import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatOrderMoney,
  getOrderSummaryRows,
  OrderLookupClient,
  type CustomerOrder,
} from "./OrderLookupClient";

const authState = vi.hoisted(() => ({
  getToken: vi.fn(),
  isLoaded: true,
  isSignedIn: false,
  user: null as null | {
    primaryEmailAddress?: { emailAddress?: string };
    username?: string;
  },
}));

vi.mock("@clerk/nextjs", () => ({
  ClerkLoaded: ({ children }: { children: ReactNode }) => <>{children}</>,
  ClerkLoading: () => null,
  useAuth: () => ({
    getToken: authState.getToken,
    isLoaded: authState.isLoaded,
    isSignedIn: authState.isSignedIn,
  }),
  useUser: () => ({ user: authState.user }),
}));

function createOrder(overrides: Partial<CustomerOrder> = {}): CustomerOrder {
  return {
    createdAt: "2026-06-20T12:00:00.000Z",
    currency: "USD",
    customerEmail: "buyer@example.com",
    customerPhone: null,
    fulfillmentStatus: "in_progress",
    id: "order-1",
    items: [
      {
        currency: "USD",
        customizationSummary: {
          adminNotes: "do not show this",
          embroidery: "Gold thread",
          liningColor: "Ivory",
        },
        fabricSnapshot: { color: "Ivory satin", internalMetadata: "hidden" },
        id: "item-1",
        listingSnapshot: { title: "Graduation stole" },
        quantity: 2,
        totalAmountCents: 30000,
        unitAmountCents: 15000,
      },
    ],
    paidAt: "2026-06-20T12:05:00.000Z",
    paymentStatus: "paid",
    publicOrderNumber: "KAP-1004",
    status: "confirmed",
    totalCents: 30000,
    tracking: {
      carrier: "UPS",
      trackingNumber: "1Z999",
      trackingUrl: "https://example.com/track",
    },
    ...overrides,
  };
}

const policySnapshot = {
  schemaVersion: 1 as const,
  bundleVersion: "2026-11-03.1",
  effectiveDate: "2026-11-03",
  statementSubmittedAt: "2026-11-03T15:00:00.000Z",
  checkoutStatement: { version: "2026-11-03.1", digest: "a".repeat(64) },
  documents: [
    { key: "shipping" as const, role: "notice" as const, version: "2026-11-03.1", digest: "b".repeat(64), path: "/policies/shipping/2026-11-03.1" },
    { key: "returns" as const, role: "acknowledgment" as const, version: "2026-11-03.1", digest: "c".repeat(64), path: "/policies/returns/2026-11-03.1" },
    { key: "privacy" as const, role: "notice" as const, version: "2026-11-03.1", digest: "d".repeat(64), path: "/policies/privacy/2026-11-03.1" },
    { key: "terms" as const, role: "agreement" as const, version: "2026-11-03.1", digest: "e".repeat(64), path: "/policies/terms/2026-11-03.1" },
  ],
};

describe("OrderLookupClient", () => {
  beforeEach(() => {
    authState.getToken.mockReset();
    authState.getToken.mockResolvedValue("test-token");
    authState.isLoaded = true;
    authState.isSignedIn = false;
    authState.user = null;
    vi.stubGlobal("fetch", vi.fn());
  });

  it("formats money and removes sensitive summary keys", () => {
    expect(formatOrderMoney(12345, "USD")).toBe("$123.45");
    expect(
      getOrderSummaryRows({
        adminNotes: "private",
        embroidery: "Gold",
        internalMetadata: "private",
      }),
    ).toEqual([{ label: "Embroidery", value: "Gold" }]);
  });

  it("submits guest lookup details and renders the returned safe order", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(createOrder()), { status: 200 }),
    );

    render(<OrderLookupClient />);

    await user.type(screen.getByLabelText("Order ID"), "KAP-1004");
    await user.type(screen.getByLabelText("Email"), "buyer@example.com");
    await user.click(screen.getByRole("button", { name: "View Order" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/orders/lookup",
        expect.objectContaining({
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        }),
      );
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(requestInit.body))).toEqual({
      email: "buyer@example.com",
      orderId: "KAP-1004",
    });
    expect(await screen.findByText("Graduation stole")).toBeInTheDocument();
    expect(screen.getByText("Gold thread")).toBeInTheDocument();
    expect(screen.queryByText("do not show this")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "UPS 1Z999" })).toHaveAttribute(
      "href",
      "https://example.com/track",
    );
  });

  it("loads account order history with a Clerk bearer token", async () => {
    authState.isSignedIn = true;
    authState.user = { primaryEmailAddress: { emailAddress: "me@example.com" } };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ orders: [createOrder()] }), { status: 200 }),
    );

    render(<OrderLookupClient />);

    expect(await screen.findByText("Graduation stole")).toBeInTheDocument();
    expect(authState.getToken).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("/api/orders/me", {
      headers: { Authorization: "Bearer test-token" },
    });
  });

  it("renders exact archived policy links for an order snapshot", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(createOrder({ policySnapshot })), { status: 200 }));

    render(<OrderLookupClient />);
    await user.type(screen.getByLabelText("Order ID"), "KAP-1004");
    await user.type(screen.getByLabelText("Email"), "buyer@example.com");
    await user.click(screen.getByRole("button", { name: "View Order" }));

    expect(await screen.findByRole("heading", { name: "Policies for this order" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/policies/privacy/2026-11-03.1");
  });
});
