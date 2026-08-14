export type CartAggregate = {
  lineItemCount: number;
  revision: number;
  totalQuantity: number;
};

export type CartSummary = CartAggregate & {
  cartId?: string;
  subtotalCents?: number;
};

const CART_INVALIDATION_EVENT = "kapchi:cart-invalidated";
const CART_INVALIDATION_STORAGE_KEY = "kapchi:cart-invalidation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid cart ${field}.`);
  }

  return Number(value);
}

export function parseCartAggregate(
  value: unknown,
  expected?: { lineItemCount: number; totalQuantity: number },
): CartAggregate {
  if (!isRecord(value)) {
    throw new Error("Invalid cart response.");
  }

  if (
    expected &&
    value.lineItemCount === undefined &&
    value.revision === undefined &&
    value.totalQuantity === undefined
  ) {
    return { ...expected, revision: 0 };
  }

  const aggregate = {
    lineItemCount: nonNegativeInteger(value.lineItemCount, "line item count"),
    revision: nonNegativeInteger(value.revision, "revision"),
    totalQuantity: nonNegativeInteger(value.totalQuantity, "total quantity"),
  };

  if (
    aggregate.totalQuantity < aggregate.lineItemCount ||
    (expected &&
      (aggregate.lineItemCount !== expected.lineItemCount ||
        aggregate.totalQuantity !== expected.totalQuantity))
  ) {
    throw new Error("Invalid cart aggregate response.");
  }

  return aggregate;
}

export function parseCartSummary(value: unknown): CartSummary {
  if (!isRecord(value)) {
    throw new Error("Invalid cart summary response.");
  }

  const aggregate = parseCartAggregate(value);
  const subtotalCents =
    value.subtotalCents === undefined
      ? undefined
      : nonNegativeInteger(value.subtotalCents, "subtotal");
  const cartId = typeof value.cartId === "string" && value.cartId.trim()
    ? value.cartId
    : undefined;

  if (!cartId && (aggregate.lineItemCount !== 0 || aggregate.totalQuantity !== 0)) {
    throw new Error("Invalid empty cart summary response.");
  }

  return {
    ...aggregate,
    cartId,
    ...(subtotalCents === undefined ? {} : { subtotalCents }),
  };
}

export function totalPhysicalQuantity(items: ReadonlyArray<{ quantity: number }>) {
  return items.reduce((total, item) => total + item.quantity, 0);
}

function invalidationToken() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function publishCartInvalidation() {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new Event(CART_INVALIDATION_EVENT));

  try {
    window.localStorage.setItem(CART_INVALIDATION_STORAGE_KEY, invalidationToken());
  } catch {
    // Same-document invalidation still works when storage is unavailable.
  }
}

export function subscribeToCartInvalidations(listener: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key === CART_INVALIDATION_STORAGE_KEY && event.newValue) {
      listener();
    }
  };

  window.addEventListener(CART_INVALIDATION_EVENT, listener);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(CART_INVALIDATION_EVENT, listener);
    window.removeEventListener("storage", handleStorage);
  };
}

export const cartInvalidationStorageKey = CART_INVALIDATION_STORAGE_KEY;
