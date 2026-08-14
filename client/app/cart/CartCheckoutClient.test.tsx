import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CartCheckoutClient } from "./CartCheckoutClient";

const authState = vi.hoisted(() => ({
  getToken: vi.fn(),
  isLoaded: true,
  isSignedIn: false,
  userId: null as string | null,
  user: null as null | {
    primaryEmailAddress?: { emailAddress?: string };
  },
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    getToken: authState.getToken,
    isLoaded: authState.isLoaded,
    isSignedIn: authState.isSignedIn,
    userId: authState.userId,
  }),
  useUser: () => ({ user: authState.user }),
}));

function cartResponse(
  overrides: Record<string, unknown> = {},
) {
  const defaultItems = [
    {
      cartItemId: "0f82fc95-66a6-41b9-9ed5-05a5a20e6f61",
      currency: "usd",
      customizationSetId: "fba94989-b950-4087-bac1-8c1ad4970655",
      customizationSummary: {
        fontOptionId: null,
        imageAssetId: null,
        line1: "Class of 2027",
        line2: "Kapchi University",
        trimOptionId: null,
      },
      fabricId: null,
      listingId: "396256fa-68f9-4882-934a-5cedffbd8204",
      listingPriceVariantId: "661f833a-41c5-4ec9-8232-e1883f6be7ed",
      listingSlug: "graduation-stole",
      quantity: 1,
      title: "Graduation Stole",
      unitAmountCents: 8500,
      validationStatus: "valid",
    },
  ];
  const items = (overrides.items ?? defaultItems) as typeof defaultItems;

  return {
    cartId: "53fcaccc-1baa-4072-abbb-c51d20f3588b",
    items,
    lineItemCount: items.length,
    revision: 1,
    subtotalCents: 8500,
    totalQuantity: items.reduce((total, item) => total + item.quantity, 0),
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
    authState.userId = null;
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
      expect.objectContaining({ credentials: "include" }),
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
    authState.userId = "user-1";
    authState.user = {
      primaryEmailAddress: { emailAddress: "member@example.com" },
    };
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    const redirect = vi.fn();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/cart/claim") {
        return jsonResponse(cartResponse({ revision: 2 }));
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
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/cart/")
    ).toHaveLength(0);
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
        jsonResponse(
          cartResponse({ items: [], revision: 2, subtotalCents: 0 }),
        ),
      );

    render(<CartCheckoutClient />);

    expect(await screen.findByText("This listing was removed.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue to secure checkout" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Remove item" }));
    expect(await screen.findByText("Your cart is empty")).toBeInTheDocument();
  });

  it("updates a complete customized line and then deletes it", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    const customized = cartResponse({
      items: [
        {
          ...cartResponse().items[0],
          customizationSummary: {
            fontOptionId: "font-1",
            imageAssetId: "asset-1",
            line1: "Class of 2027",
            line2: "Kapchi University",
            trimOptionId: "trim-1",
          },
          fabricId: "fabric-1",
        },
      ],
    });
    const updated = cartResponse({
      items: [{ ...customized.items[0], quantity: 2 }],
      subtotalCents: 17000,
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(customized))
      .mockResolvedValueOnce(jsonResponse(updated))
      .mockResolvedValueOnce(
        jsonResponse(
          cartResponse({ items: [], revision: 3, subtotalCents: 0 }),
        ),
      );

    render(<CartCheckoutClient />);
    await screen.findByText("Graduation Stole");
    await user.click(
      screen.getByRole("button", {
        name: "Increase Graduation Stole quantity",
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("group", { name: "Quantity for Graduation Stole" }),
      ).toHaveTextContent("2"),
    );
    expect(screen.getByText("2 items")).toBeInTheDocument();
    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/cart/items/0f82fc95-66a6-41b9-9ed5-05a5a20e6f61" &&
        init?.method === "PATCH",
    );
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      fabricId: "fabric-1",
      fontOptionId: "font-1",
      imageAssetId: "asset-1",
      line1: "Class of 2027",
      line2: "Kapchi University",
      listingCustomizationSetId: "fba94989-b950-4087-bac1-8c1ad4970655",
      listingId: "396256fa-68f9-4882-934a-5cedffbd8204",
      listingPriceVariantId: "661f833a-41c5-4ec9-8232-e1883f6be7ed",
      quantity: 2,
      trimOptionId: "trim-1",
    });

    await user.click(screen.getByRole("button", { name: "Remove item" }));
    expect(await screen.findByText("Your cart is empty")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cart/items/0f82fc95-66a6-41b9-9ed5-05a5a20e6f61",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("clears the cart count when a mutation reports CART_NOT_FOUND", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(cartResponse()))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: "CART_NOT_FOUND",
            message: "Cart not found.",
            statusCode: 404,
          },
          404,
        ),
      );

    render(<CartCheckoutClient />);
    await screen.findByText("Graduation Stole");
    await user.click(screen.getByRole("button", { name: "Remove item" }));

    expect(await screen.findByText("Your cart is empty")).toBeInTheDocument();
  });

  it("does not let an older cart revision overwrite newer state", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    const current = cartResponse({
      items: [{ ...cartResponse().items[0], quantity: 2 }],
      revision: 3,
      subtotalCents: 17000,
    });
    const stale = cartResponse({
      items: [{ ...cartResponse().items[0], quantity: 3 }],
      revision: 2,
      subtotalCents: 25500,
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(current))
      .mockResolvedValueOnce(jsonResponse(stale));

    render(<CartCheckoutClient />);
    await screen.findByText("2 items");
    await user.click(
      screen.getByRole("button", { name: "Increase Graduation Stole quantity" }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("group", { name: "Quantity for Graduation Stole" }),
    ).toHaveTextContent("2");
    expect(screen.getByText("2 items")).toBeInTheDocument();
  });

  it("blocks checkout while a quantity mutation is in flight", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    let resolveUpdate!: (response: Response) => void;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(cartResponse()))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveUpdate = resolve;
        }),
      );

    render(<CartCheckoutClient />);
    await screen.findByText("Graduation Stole");
    await user.click(
      screen.getByRole("button", { name: "Increase Graduation Stole quantity" }),
    );

    expect(
      screen.getByRole("button", { name: "Continue to secure checkout" }),
    ).toBeDisabled();

    await act(async () => {
      resolveUpdate(
        jsonResponse(
          cartResponse({
            items: [{ ...cartResponse().items[0], quantity: 2 }],
            revision: 2,
            subtotalCents: 17000,
          }),
        ),
      );
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Continue to secure checkout" }),
      ).toBeEnabled(),
    );
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

  it("retains contact data without offering retry for a catalog failure", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(cartResponse()))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: "CHECKOUT_CATALOG_UNAVAILABLE",
            message: "private provider catalog details",
            statusCode: 503,
          },
          503,
        ),
      );

    render(<CartCheckoutClient redirectToCheckout={vi.fn()} />);
    await screen.findByText("Graduation Stole");
    await user.type(screen.getByLabelText("Email"), "guest@example.com");
    await user.type(screen.getByLabelText("Phone"), "+15550101010");
    await user.click(
      screen.getByRole("button", { name: "Continue to secure checkout" }),
    );

    expect(
      await screen.findByText(/Secure checkout is unavailable for one or more items/),
    ).toBeInTheDocument();
    expect(screen.queryByText("private provider catalog details")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try checkout again" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("guest@example.com");
    expect(screen.getByLabelText("Phone")).toHaveValue("+15550101010");
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => url === "/api/payments/checkout-sessions",
      ),
    ).toHaveLength(1);
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
