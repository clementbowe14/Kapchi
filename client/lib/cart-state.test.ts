import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cartInvalidationStorageKey,
  parseCartAggregate,
  parseCartSummary,
  publishCartInvalidation,
  subscribeToCartInvalidations,
  totalPhysicalQuantity,
} from "./cart-state";

describe("cart state helpers", () => {
  const setItem = vi.fn();

  beforeEach(() => {
    setItem.mockReset();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { setItem },
    });
  });

  it("uses physical-unit quantity and validates server aggregates", () => {
    expect(totalPhysicalQuantity([{ quantity: 2 }, { quantity: 3 }])).toBe(5);
    expect(
      parseCartAggregate(
        { lineItemCount: 2, revision: 7, totalQuantity: 5 },
        { lineItemCount: 2, totalQuantity: 5 },
      ),
    ).toEqual({ lineItemCount: 2, revision: 7, totalQuantity: 5 });

    expect(() =>
      parseCartAggregate(
        { lineItemCount: 2, revision: 7, totalQuantity: 2 },
        { lineItemCount: 2, totalQuantity: 5 },
      ),
    ).toThrow("Invalid cart aggregate response");
  });

  it("derives full-view aggregates while an older backend is rolling out", () => {
    expect(
      parseCartAggregate({}, { lineItemCount: 2, totalQuantity: 5 }),
    ).toEqual({ lineItemCount: 2, revision: 0, totalQuantity: 5 });

    expect(() =>
      parseCartAggregate(
        { lineItemCount: 2 },
        { lineItemCount: 2, totalQuantity: 5 },
      ),
    ).toThrow("Invalid cart revision");
  });

  it("accepts a non-creating empty summary without inventing a cart", () => {
    expect(
      parseCartSummary({
        lineItemCount: 0,
        revision: 0,
        subtotalCents: 0,
        totalQuantity: 0,
      }),
    ).toEqual({
      cartId: undefined,
      lineItemCount: 0,
      revision: 0,
      subtotalCents: 0,
      totalQuantity: 0,
    });

    expect(
      parseCartSummary({
        lineItemCount: 0,
        revision: 0,
        totalQuantity: 0,
      }),
    ).toEqual({
      cartId: undefined,
      lineItemCount: 0,
      revision: 0,
      totalQuantity: 0,
    });
  });

  it("notifies this document and other tabs without sharing cart data", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToCartInvalidations(listener);

    publishCartInvalidation();
    expect(listener).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith(
      cartInvalidationStorageKey,
      expect.not.stringContaining("cart"),
    );

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: cartInvalidationStorageKey,
        newValue: "opaque-revision-token",
      }),
    );
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it("keeps same-document invalidation working when storage is unavailable", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToCartInvalidations(listener);
    setItem.mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(() => publishCartInvalidation()).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
  });
});
