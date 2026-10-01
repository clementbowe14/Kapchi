import { describe, expect, it, vi } from "vitest";
import {
  createCartObserver,
  observableCartFields
} from "./cart-observer.js";

function logger() {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  };
}

describe("cart observer", () => {
  it("emits bounded success fields with a monotonic duration", () => {
    const log = logger();
    const now = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(12.34567);
    const observer = createCartObserver(log as never, { now });
    const startedAt = observer.start();

    observer.completed(
      "cart.item.added",
      {
        actorType: "guest",
        cartId: "53fcaccc-1baa-4072-abbb-c51d20f3588b",
        cartItemId: "0f82fc95-66a6-41b9-9ed5-05a5a20e6f61",
        customizationPackageId: "fba94989-b950-4087-bac1-8c1ad4970655",
        estimateOutcome: "accepted",
        lineItemCount: 2,
        listingId: "396256fa-68f9-4882-934a-5cedffbd8204",
        operation: "add",
        priorityCode: "standard",
        revision: 4,
        ruleId: "00000000-0000-4000-8000-000000000093",
        ruleRevision: 1,
        subtotalCents: 17000,
        totalQuantity: 3
      },
      startedAt,
    );

    expect(log.info).toHaveBeenCalledWith(
      {
        actorType: "guest",
        cartId: "53fcaccc-1baa-4072-abbb-c51d20f3588b",
        cartItemId: "0f82fc95-66a6-41b9-9ed5-05a5a20e6f61",
        customizationPackageId: "fba94989-b950-4087-bac1-8c1ad4970655",
        durationMs: 2.346,
        estimateOutcome: "accepted",
        event: "cart.item.added",
        lineItemCount: 2,
        listingId: "396256fa-68f9-4882-934a-5cedffbd8204",
        operation: "add",
        priorityCode: "standard",
        revision: 4,
        ruleId: "00000000-0000-4000-8000-000000000093",
        ruleRevision: 1,
        subtotalCents: 17000,
        totalQuantity: 3
      },
      "Cart lifecycle event",
    );
  });

  it("records handled failures without exposing raw errors", () => {
    const log = logger();
    const observer = createCartObserver(log as never, { now: () => 20 });
    const secretError = new Error(
      "cookie=session-secret customer@example.com Class of 2028 crest.png",
    );

    observer.failed(
      {
        actorType: "guest",
        errorCode: "CART_IDEMPOTENCY_CONFLICT",
        operation: "add",
        statusCode: 409
      },
      secretError,
      19,
    );

    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      {
        actorType: "guest",
        durationMs: 1,
        errorCode: "CART_IDEMPOTENCY_CONFLICT",
        errorType: "Error",
        event: "cart.operation.failed",
        operation: "add",
        retryable: false,
        statusCode: 409
      },
      "Cart lifecycle event",
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("session-secret");
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("customer@example.com");
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("Class of 2028");
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("crest.png");
  });

  it("uses error level for server failures and ignores logger failures", () => {
    const log = logger();
    log.error.mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const observer = createCartObserver(log as never, { now: () => 3 });

    expect(() =>
      observer.failed(
        { actorType: "authenticated", operation: "claim", statusCode: 500 },
        Object.assign(new Error("database unavailable"), { code: "ECONNRESET" }),
        2,
      ),
    ).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "ECONNRESET",
        event: "cart.operation.failed",
        statusCode: 500
      }),
      "Cart lifecycle event",
    );
  });

  it("extracts only safe cart metrics from service results", () => {
    expect(
      observableCartFields({
        cartId: "cart_safe-1",
        cartItemId: "item_safe-1",
        customerEmail: "private@example.com",
        idempotencyKey: "private-key",
        lineItemCount: 2,
        requestBody: { line1: "Private text" },
        productionEstimateDiagnostics: {
          customizationPackageId: "package_safe-1",
          listingId: "listing_safe-1",
          outcome: "preserved",
          priorityCode: "standard",
          ruleId: "rule_safe-1",
          ruleRevision: 2,
          snapshot: { priorityLabel: "do not log this object" },
        },
        revision: 8,
        subtotalCents: 9000,
        totalQuantity: 5
      }),
    ).toEqual({
      cartId: "cart_safe-1",
      cartItemId: "item_safe-1",
      customizationPackageId: "package_safe-1",
      estimateOutcome: "preserved",
      lineItemCount: 2,
      listingId: "listing_safe-1",
      priorityCode: "standard",
      revision: 8,
      ruleId: "rule_safe-1",
      ruleRevision: 2,
      subtotalCents: 9000,
      totalQuantity: 5
    });

    expect(
      observableCartFields({
        cartId: "unsafe/cart",
        lineItemCount: -1,
        revision: Number.MAX_SAFE_INTEGER + 1,
        subtotalCents: 1.5,
        totalQuantity: "3"
      }),
    ).toEqual({});
  });
});
