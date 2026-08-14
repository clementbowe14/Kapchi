import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CheckoutProviderPriceUnavailableError,
  type CheckoutProvider,
  type CheckoutProviderSession
} from "./checkout-provider.js";
import {
  CheckoutService,
  type CheckoutServiceDependencies
} from "./checkout-service.js";

const orderId = "2db9f8e1-d0f0-4b39-b521-1ab59db038c8";
const replacementOrderId = "7ad85754-c339-4214-af6e-519eabc38501";
const context = {
  cartId: "53fcaccc-1baa-4072-abbb-c51d20f3588b",
  sessionId: "valid_session_id_abcdefghijklmnopqrstuvwxyz123456789"
};
const contact = {
  customerEmail: "customer@example.com",
  customerPhone: null,
  preferredContactMethod: "email" as const
};
const redirects = {
  cancelUrl: "https://kapchi.test/cart",
  successUrl: "https://kapchi.test/orders"
};
const now = new Date("2026-08-01T12:00:00.000Z");

function preparedCheckout(
  id = orderId,
  existingStripeSessionId: string | null = null,
) {
  return {
    cartId: context.cartId,
    cartRevision: 3,
    cartStatus: "active" as const,
    customerEmail: contact.customerEmail,
    existingStripeSessionId,
    lines: [
      {
        currency: "usd",
        orderItemId: "5863e978-6764-41f4-96bd-ea2337d11204",
        quantity: 2,
        stripePriceId: "price_test_stole"
      }
    ],
    orderId: id,
    publicOrderNumber: `KAP-${id.replace(/-/g, "").slice(0, 12).toUpperCase()}`,
    reusedOrder: existingStripeSessionId !== null
  };
}

function createRepository(
  existingStripeSessionId: string | null = null,
) {
  return {
    finalizeCheckout: vi.fn(),
    getCheckoutStatus: vi.fn(),
    markCatalogUnavailable: vi.fn(async () => ({
      cartId: context.cartId,
      cartStatus: "active" as const,
      orderRetired: true
    })),
    markProviderFailure: vi.fn(),
    prepareCheckout: vi.fn(async () =>
      preparedCheckout(orderId, existingStripeSessionId),
    ),
    retireTerminalCheckout: vi.fn()
  };
}

function providerSession(
  overrides: Partial<CheckoutProviderSession> = {},
): CheckoutProviderSession {
  return {
    customerId: "cus_test_123",
    expiresAt: new Date("2026-08-01T13:00:00.000Z"),
    id: "cs_test_123",
    paymentStatus: "unpaid",
    status: "open",
    url: "https://checkout.stripe.com/c/pay/cs_test_123",
    ...overrides
  };
}

function createObserver() {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  };
}

describe("CheckoutService", () => {
  const createSession = vi.fn();
  const retrieveSession = vi.fn();

  beforeEach(() => {
    createSession.mockReset();
    retrieveSession.mockReset();
  });

  function createService(
    overrides: Partial<CheckoutServiceDependencies> = {},
  ) {
    const repository = overrides.repository ?? createRepository();
    const observer = overrides.observer ?? createObserver();
    const provider: CheckoutProvider = overrides.provider ?? {
      createSession,
      retrieveSession
    };
    const service = new CheckoutService({
      clock: overrides.clock ?? { now: () => now },
      observer,
      provider,
      redirects: overrides.redirects ?? redirects,
      repository
    });

    return { observer, provider, repository, service };
  }

  it("uses injected redirects and durable identity for provider creation", async () => {
    const repository = createRepository();
    const observer = createObserver();
    createSession.mockResolvedValue(providerSession());
    const { service } = createService({ observer, repository });

    const result = await service.startCheckout(context, contact);

    expect(result).toEqual({
      checkoutSessionId: "cs_test_123",
      orderId,
      paymentStatus: "checkout_started",
      publicOrderNumber: "KAP-2DB9F8E1D0F0",
      url: "https://checkout.stripe.com/c/pay/cs_test_123"
    });
    expect(createSession).toHaveBeenCalledWith(
      {
        cancelUrl: "https://kapchi.test/cart",
        customerEmail: "customer@example.com",
        lines: [
          expect.objectContaining({
            quantity: 2,
            stripePriceId: "price_test_stole"
          })
        ],
        orderId,
        successUrl:
          "https://kapchi.test/orders?checkout_session_id={CHECKOUT_SESSION_ID}"
      },
      `cart-checkout:${orderId}`,
    );
    expect(repository.finalizeCheckout).toHaveBeenCalledWith(orderId, {
      customerId: "cus_test_123",
      expiresAt: new Date("2026-08-01T13:00:00.000Z"),
      sessionId: "cs_test_123"
    });
    expect(observer.info).toHaveBeenCalledWith("checkout.succeeded", {
      orderId,
      providerSessionId: "cs_test_123"
    });
  });

  it("retrieves and observes a reusable existing provider session", async () => {
    const repository = createRepository("cs_test_123");
    const observer = createObserver();
    retrieveSession.mockResolvedValue(providerSession());
    const { service } = createService({ observer, repository });

    const result = await service.startCheckout(context, contact);

    expect(retrieveSession).toHaveBeenCalledWith("cs_test_123");
    expect(createSession).not.toHaveBeenCalled();
    expect(result.publicOrderNumber).toBe("KAP-2DB9F8E1D0F0");
    expect(observer.info).toHaveBeenCalledWith(
      "checkout.provider.session_reused",
      {
        disposition: "reusable",
        orderId,
        providerSessionId: "cs_test_123"
      },
    );
  });

  it("uses the injected clock to retire an expired session and replace it", async () => {
    const repository = createRepository("cs_test_expired");
    repository.prepareCheckout
      .mockResolvedValueOnce(preparedCheckout(orderId, "cs_test_expired"))
      .mockResolvedValueOnce(preparedCheckout(replacementOrderId));
    retrieveSession.mockResolvedValue(
      providerSession({
        expiresAt: new Date("2026-08-01T12:30:00.000Z"),
        id: "cs_test_expired"
      }),
    );
    createSession.mockResolvedValue(
      providerSession({ id: "cs_test_replacement" }),
    );
    const { service } = createService({
      clock: { now: () => new Date("2026-08-01T12:45:00.000Z") },
      repository
    });

    const result = await service.startCheckout(context, contact);

    expect(repository.retireTerminalCheckout).toHaveBeenCalledWith(
      orderId,
      expect.objectContaining({ sessionId: "cs_test_expired" }),
      "provider_session_expired",
    );
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: replacementOrderId }),
      `cart-checkout:${replacementOrderId}`,
    );
    expect(result.orderId).toBe(replacementOrderId);
  });

  it("does not replace a complete or paid provider session", async () => {
    const repository = createRepository("cs_test_complete");
    retrieveSession.mockResolvedValue(
      providerSession({
        id: "cs_test_complete",
        paymentStatus: "paid",
        status: "complete",
        url: null
      }),
    );
    const { service } = createService({ repository });

    await expect(service.startCheckout(context, contact)).rejects.toMatchObject({
      checkoutSessionId: "cs_test_complete",
      name: "CheckoutAlreadyCompleteError",
      orderId,
      publicOrderNumber: "KAP-2DB9F8E1D0F0"
    });
    expect(repository.retireTerminalCheckout).not.toHaveBeenCalled();
    expect(repository.markProviderFailure).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("retires a newly created session that has no reusable URL", async () => {
    const repository = createRepository();
    createSession.mockResolvedValue(providerSession({ url: null }));
    const { service } = createService({ repository });

    await expect(service.startCheckout(context, contact)).rejects.toMatchObject({
      name: "CheckoutProviderError"
    });
    expect(repository.retireTerminalCheckout).toHaveBeenCalledWith(
      orderId,
      expect.objectContaining({ sessionId: "cs_test_123" }),
      "provider_session_unusable",
    );
    expect(repository.markProviderFailure).not.toHaveBeenCalled();
  });

  it("marks provider failure and observes only safe error details", async () => {
    const repository = createRepository();
    const observer = createObserver();
    createSession.mockRejectedValue(
      new Error("sk_test_secret provider outage for customer@example.com"),
    );
    const { service } = createService({ observer, repository });

    await expect(service.startCheckout(context, contact)).rejects.toMatchObject({
      message: "Unable to start checkout. Please try again.",
      name: "CheckoutProviderError"
    });
    expect(repository.markProviderFailure).toHaveBeenCalledWith(orderId);
    expect(repository.markCatalogUnavailable).not.toHaveBeenCalled();
    expect(repository.retireTerminalCheckout).not.toHaveBeenCalled();
    expect(observer.error).toHaveBeenCalledWith("checkout.provider.failed", {
      errorType: "Error",
      orderId,
      providerOperation: "create"
    });
    expect(JSON.stringify(observer.error.mock.calls)).not.toContain("sk_test_secret");
    expect(JSON.stringify(observer.error.mock.calls)).not.toContain(
      "customer@example.com",
    );
  });

  it("converts a missing line item Price into a safe catalog failure", async () => {
    const repository = createRepository();
    const observer = createObserver();
    createSession.mockRejectedValue(
      new CheckoutProviderPriceUnavailableError(),
    );
    const { service } = createService({ observer, repository });

    await expect(service.startCheckout(context, contact)).rejects.toMatchObject({
      code: "CHECKOUT_CATALOG_UNAVAILABLE",
      message:
        "Checkout is unavailable for one or more items. Please contact Kapchi support.",
      name: "CheckoutCatalogUnavailableError"
    });
    expect(repository.markCatalogUnavailable).toHaveBeenCalledWith(orderId);
    expect(repository.markProviderFailure).not.toHaveBeenCalled();
    expect(repository.retireTerminalCheckout).not.toHaveBeenCalled();
    expect(observer.error).toHaveBeenCalledWith(
      "checkout.catalog.unavailable",
      {
        errorCode: "resource_missing",
        errorType: "CheckoutProviderPriceUnavailableError",
        orderId,
        providerOperation: "create"
      },
    );
    expect(observer.warn).toHaveBeenCalledWith("checkout.catalog.retired", {
      cartId: context.cartId,
      cartStatus: "active",
      orderId,
      resultCode: "CATALOG_ORDER_RETIRED"
    });
    const observed = JSON.stringify(observer.error.mock.calls);
    expect(observed).not.toContain(contact.customerEmail);
    expect(observed).not.toContain("price_test_stole");
    expect(observed).not.toContain("checkout.stripe.com");
  });

  it("reports catalog marker persistence failures without leaking details", async () => {
    const repository = createRepository();
    const observer = createObserver();
    const persistenceError = Object.assign(
      new Error("postgres://private-catalog-host"),
      { code: "40001" },
    );
    createSession.mockRejectedValue(
      new CheckoutProviderPriceUnavailableError(),
    );
    repository.markCatalogUnavailable.mockRejectedValue(persistenceError);
    const { service } = createService({ observer, repository });

    await expect(service.startCheckout(context, contact)).rejects.toBe(
      persistenceError,
    );
    expect(repository.markProviderFailure).not.toHaveBeenCalled();
    expect(observer.error).toHaveBeenCalledWith("checkout.persistence.failed", {
      errorCode: "40001",
      errorType: "Error",
      operation: "mark_catalog_unavailable",
      orderId
    });
    expect(JSON.stringify(observer.error.mock.calls)).not.toContain(
      "private-catalog-host",
    );
  });

  it("reports persistence failure while recording provider recovery", async () => {
    const repository = createRepository();
    const observer = createObserver();
    createSession.mockRejectedValue(new Error("provider timeout"));
    repository.markProviderFailure.mockRejectedValue(
      Object.assign(new Error("postgres://private-host"), {
        code: "ECONNRESET"
      }),
    );
    const { service } = createService({ observer, repository });

    await expect(service.startCheckout(context, contact)).rejects.toMatchObject({
      code: "ECONNRESET"
    });
    expect(observer.error).toHaveBeenCalledWith("checkout.persistence.failed", {
      errorCode: "ECONNRESET",
      errorType: "Error",
      operation: "mark_provider_failure",
      orderId
    });
    expect(JSON.stringify(observer.error.mock.calls)).not.toContain("private-host");
  });

  it("reports finalization failures without logging database messages", async () => {
    const repository = createRepository();
    const observer = createObserver();
    const databaseError = Object.assign(
      new Error("database password private-value"),
      { code: "40001" },
    );
    repository.finalizeCheckout.mockRejectedValue(databaseError);
    createSession.mockResolvedValue(providerSession());
    const { service } = createService({ observer, repository });

    await expect(service.startCheckout(context, contact)).rejects.toBe(
      databaseError,
    );
    expect(observer.error).toHaveBeenCalledWith("checkout.persistence.failed", {
      errorCode: "40001",
      errorType: "Error",
      operation: "finalize",
      orderId,
      providerSessionId: "cs_test_123"
    });
    expect(JSON.stringify(observer.error.mock.calls)).not.toContain(
      "private-value",
    );
  });

  it("retries provider timeouts with the same idempotency identity", async () => {
    const repository = createRepository();
    createSession
      .mockRejectedValueOnce(new Error("provider timeout"))
      .mockResolvedValueOnce(providerSession());
    const { service } = createService({ repository });

    await expect(service.startCheckout(context, contact)).rejects.toMatchObject({
      name: "CheckoutProviderError"
    });
    await expect(service.startCheckout(context, contact)).resolves.toMatchObject({
      orderId
    });
    expect(createSession.mock.calls[0][1]).toBe(`cart-checkout:${orderId}`);
    expect(createSession.mock.calls[1][1]).toBe(`cart-checkout:${orderId}`);
  });
});
