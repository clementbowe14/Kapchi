import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CheckoutConfirmationClient } from "./CheckoutConfirmationClient";

const authState = vi.hoisted(() => ({
  getToken: vi.fn(),
  isLoaded: true,
  isSignedIn: false,
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    getToken: authState.getToken,
    isLoaded: authState.isLoaded,
    isSignedIn: authState.isSignedIn,
  }),
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("CheckoutConfirmationClient", () => {
  beforeEach(() => {
    authState.getToken.mockReset();
    authState.getToken.mockResolvedValue("clerk-test-token");
    authState.isLoaded = true;
    authState.isSignedIn = false;
    vi.stubGlobal("fetch", vi.fn());
  });

  it("verifies guest ownership and displays the order identity", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
        paymentStatus: "paid",
        publicOrderNumber: "KAP-2DB9F8E1D0F0",
      }),
    );

    render(
      <CheckoutConfirmationClient checkoutSessionId="cs_test_checkout" />,
    );

    expect(await screen.findByText("Payment confirmed")).toBeInTheDocument();
    expect(screen.getByText("KAP-2DB9F8E1D0F0")).toBeInTheDocument();
    expect(
      screen.getByText("2db9f8e1-d0f0-4b39-b521-1ab59db038c8"),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/payments/checkout-sessions/cs_test_checkout/status",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("uses Clerk authentication for account confirmation", async () => {
    authState.isSignedIn = true;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
        paymentStatus: "paid",
        publicOrderNumber: "KAP-2DB9F8E1D0F0",
      }),
    );

    render(
      <CheckoutConfirmationClient checkoutSessionId="cs_test_account" />,
    );

    await screen.findByText("Payment confirmed");
    expect(authState.getToken).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/payments/checkout-sessions/cs_test_account/status",
      expect.objectContaining({
        headers: { Authorization: "Bearer clerk-test-token" },
      }),
    );
  });

  it("shows a bounded pending state and lets the customer check again", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
          paymentStatus: "checkout_started",
          publicOrderNumber: "KAP-2DB9F8E1D0F0",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
          paymentStatus: "paid",
          publicOrderNumber: "KAP-2DB9F8E1D0F0",
        }),
      );

    render(
      <CheckoutConfirmationClient
        checkoutSessionId="cs_test_pending"
        pollDelaysMs={[0]}
      />,
    );

    expect(await screen.findByText("Payment is processing")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check payment again" }));
    expect(await screen.findByText("Payment confirmed")).toBeInTheDocument();
  });

  it("does not call the backend for a malformed session reference", async () => {
    const fetchMock = vi.mocked(fetch);

    render(
      <CheckoutConfirmationClient checkoutSessionId="not-a-stripe-session" />,
    );

    expect(
      await screen.findByText("Confirmation link incomplete"),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces ownership failures without revealing order data", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "CHECKOUT_NOT_FOUND",
          message: "Checkout not found.",
          statusCode: 404,
        },
        404,
      ),
    );

    render(
      <CheckoutConfirmationClient checkoutSessionId="cs_test_other" />,
    );

    expect(
      await screen.findByText("We could not confirm payment"),
    ).toBeInTheDocument();
    expect(screen.getByText(/current customer/)).toBeInTheDocument();
    expect(screen.queryByText(/KAP-/)).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  });
});
