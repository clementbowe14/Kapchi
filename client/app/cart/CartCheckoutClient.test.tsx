import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CartCheckoutClient } from "./CartCheckoutClient";

const authState = vi.hoisted(() => ({
  getToken: vi.fn(),
  isLoaded: true,
  isSignedIn: false,
  user: null as null | {
    primaryEmailAddress?: { emailAddress?: string };
  },
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    getToken: authState.getToken,
    isLoaded: authState.isLoaded,
    isSignedIn: authState.isSignedIn,
  }),
  useUser: () => ({ user: authState.user }),
}));

function cartResponse(
  overrides: Record<string, unknown> = {},
) {
  return {
    cartId: "53fcaccc-1baa-4072-abbb-c51d20f3588b",
    items: [
      {
        cartItemId: "0f82fc95-66a6-41b9-9ed5-05a5a20e6f61",
        currency: "usd",
        customizationSummary: {
          imageAssetId: null,
          line1: "Class of 2027",
          line2: "Kapchi University",
        },
        fabricId: null,
        listingId: "396256fa-68f9-4882-934a-5cedffbd8204",
        listingSlug: "graduation-stole",
        quantity: 1,
        title: "Graduation Stole",
        unitAmountCents: 8500,
        validationStatus: "valid",
      },
    ],
    subtotalCents: 8500,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("CartCheckoutClient", () => {
  beforeEach(() => {
    authState.getToken.mockReset();
    authState.getToken.mockResolvedValue("clerk-test-token");
    authState.isLoaded = true;
    authState.isSignedIn = false;
    authState.user = null;
    vi.stubGlobal("fetch", vi.fn());
  });

  it("loads a guest cart and requires email and phone before submission", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(cartResponse()));

    render(<CartCheckoutClient />);

    expect(await screen.findByText("Graduation Stole")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Continue to secure checkout" }),
    );

    expect(screen.getByText("Enter your email address.")).toBeInTheDocument();
    expect(screen.getByText("Enter your phone number.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cart/",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("submits only contact data and follows a validated Stripe URL", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    const redirect = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(cartResponse()))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            checkoutSessionId: "cs_test_checkout",
            orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
            paymentStatus: "checkout_started",
            publicOrderNumber: "KAP-2DB9F8E1D0F0",
            url: "https://checkout.stripe.com/c/pay/cs_test_checkout",
          },
          201,
        ),
      );

    render(<CartCheckoutClient redirectToCheckout={redirect} />);
    await screen.findByText("Graduation Stole");
    await user.type(screen.getByLabelText("Email"), "guest@example.com");
    await user.type(screen.getByLabelText("Phone"), "+1 (555) 010-1010");
    await user.click(
      screen.getByRole("button", { name: "Continue to secure checkout" }),
    );

    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith(
        "https://checkout.stripe.com/c/pay/cs_test_checkout",
      ),
    );
    const checkoutCall = fetchMock.mock.calls.find(
      ([url]) => url === "/api/payments/checkout-sessions",
    );
    const request = checkoutCall?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      customerEmail: "guest@example.com",
      customerPhone: "+1 (555) 010-1010",
      preferredContactMethod: "email",
    });
    expect(JSON.stringify(request.body)).not.toContain("subtotal");
    expect(JSON.stringify(request.body)).not.toContain("cartId");
  });

  it("claims a guest cart and checks out an account with a Clerk token", async () => {
    authState.isSignedIn = true;
    authState.user = {
      primaryEmailAddress: { emailAddress: "member@example.com" },
    };
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    const redirect = vi.fn();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/cart/claim") {
        return jsonResponse({ claimed: true });
      }
      if (url === "/api/cart/") {
        return jsonResponse(cartResponse());
      }
      return jsonResponse(
        {
          orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
          paymentStatus: "checkout_started",
          publicOrderNumber: "KAP-2DB9F8E1D0F0",
          url: "https://checkout.stripe.com/c/pay/cs_test_account",
        },
        201,
      );
    });

    render(<CartCheckoutClient redirectToCheckout={redirect} />);

    expect(await screen.findByDisplayValue("member@example.com")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Continue to secure checkout" }),
    );

    await waitFor(() => expect(redirect).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cart/claim",
      expect.objectContaining({
        headers: { Authorization: "Bearer clerk-test-token" },
        method: "POST",
      }),
    );
    const checkoutCall = fetchMock.mock.calls.find(
      ([url]) => url === "/api/payments/checkout-sessions",
    );
    expect(checkoutCall?.[1]).toEqual(
      expect.objectContaining({
        headers: {
          Authorization: "Bearer clerk-test-token",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("blocks unavailable items and lets a guest remove them", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    const unavailable = cartResponse({
      items: [
        {
          ...cartResponse().items[0],
          validationMessage: "This listing was removed.",
          validationStatus: "unavailable",
        },
      ],
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(unavailable))
      .mockResolvedValueOnce(
        jsonResponse({ cartId: unavailable.cartId, items: [], subtotalCents: 0 }),
      );

    render(<CartCheckoutClient />);

    expect(await screen.findByText("This listing was removed.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue to secure checkout" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Remove item" }));
    expect(await screen.findByText("Your cart is empty")).toBeInTheDocument();
  });

  it("retains contact data and safely retries a provider failure", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    const redirect = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(cartResponse()))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: "CHECKOUT_PROVIDER_ERROR",
            message: "Unable to start checkout.",
            statusCode: 502,
          },
          502,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
            paymentStatus: "checkout_started",
            publicOrderNumber: "KAP-2DB9F8E1D0F0",
            url: "https://checkout.stripe.com/c/pay/cs_test_retry",
          },
          201,
        ),
      );

    render(<CartCheckoutClient redirectToCheckout={redirect} />);
    await screen.findByText("Graduation Stole");
    await user.type(screen.getByLabelText("Email"), "guest@example.com");
    await user.type(screen.getByLabelText("Phone"), "+15550101010");
    await user.click(
      screen.getByRole("button", { name: "Continue to secure checkout" }),
    );

    expect(await screen.findByText(/Stripe is temporarily unavailable/)).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("guest@example.com");
    expect(screen.getByLabelText("Phone")).toHaveValue("+15550101010");
    await user.click(screen.getByRole("button", { name: "Try checkout again" }));
    await waitFor(() => expect(redirect).toHaveBeenCalledOnce());
  });

  it("recovers an already-completed checkout through confirmation", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    const redirectToConfirmation = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(cartResponse()))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            checkoutSessionId: "cs_test_complete",
            error: "CHECKOUT_ALREADY_COMPLETE",
            message: "This checkout has already completed.",
            orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
            publicOrderNumber: "KAP-2DB9F8E1D0F0",
            statusCode: 409,
          },
          409,
        ),
      );

    render(
      <CartCheckoutClient redirectToConfirmation={redirectToConfirmation} />,
    );
    await screen.findByText("Graduation Stole");
    await user.type(screen.getByLabelText("Email"), "guest@example.com");
    await user.type(screen.getByLabelText("Phone"), "+15550101010");
    await user.click(
      screen.getByRole("button", { name: "Continue to secure checkout" }),
    );

    await waitFor(() =>
      expect(redirectToConfirmation).toHaveBeenCalledWith(
        "/checkout/confirmation?checkout_session_id=cs_test_complete",
      ),
    );
  });

  it("reloads item state when the backend requires cart review", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    const reviewCart = cartResponse({
      items: [
        {
          ...cartResponse().items[0],
          validationMessage: "The cart price changed and must be reviewed.",
          validationStatus: "needs_reprice",
        },
      ],
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(cartResponse()))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: "CART_NEEDS_REVIEW",
            issues: [
              {
                cartItemId: cartResponse().items[0].cartItemId,
                message: "The cart price changed and must be reviewed.",
                status: "needs_reprice",
              },
            ],
            message: "The cart price changed and must be reviewed.",
            statusCode: 409,
          },
          409,
        ),
      )
      .mockResolvedValueOnce(jsonResponse(reviewCart));

    render(<CartCheckoutClient />);
    await screen.findByText("Graduation Stole");
    await user.type(screen.getByLabelText("Email"), "guest@example.com");
    await user.type(screen.getByLabelText("Phone"), "+15550101010");
    await user.click(
      screen.getByRole("button", { name: "Continue to secure checkout" }),
    );

    expect(
      await screen.findByText("The cart price changed and must be reviewed."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue to secure checkout" }),
    ).toBeDisabled();
  });

  it("uses a synchronous guard to prevent duplicate checkout requests", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    let resolveCheckout: ((response: Response) => void) | undefined;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(cartResponse()))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveCheckout = resolve;
          }),
      );

    render(<CartCheckoutClient redirectToCheckout={vi.fn()} />);
    await screen.findByText("Graduation Stole");
    await user.type(screen.getByLabelText("Email"), "guest@example.com");
    await user.type(screen.getByLabelText("Phone"), "+15550101010");
    const button = screen.getByRole("button", {
      name: "Continue to secure checkout",
    });
    await user.dblClick(button);

    expect(
      fetchMock.mock.calls.filter(
        ([url]) => url === "/api/payments/checkout-sessions",
      ),
    ).toHaveLength(1);
    resolveCheckout?.(
      jsonResponse(
        {
          orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
          paymentStatus: "checkout_started",
          publicOrderNumber: "KAP-2DB9F8E1D0F0",
          url: "https://checkout.stripe.com/c/pay/cs_test_once",
        },
        201,
      ),
    );
  });
});
