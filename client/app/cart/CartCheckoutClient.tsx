"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { Minus, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildApiUrl } from "@/lib/api";
import { publishCartInvalidation } from "@/lib/cart-state";
import {
  cartNeedsReview,
  buildCartItemMutation,
  checkoutErrorMessage,
  CheckoutApiError,
  type CartLine,
  type CartView,
  formatCheckoutMoney,
  getCartLineIssue,
  getSafeHostedCheckoutUrl,
  isRetryableCheckoutError,
  parseCartView,
  type PreferredContactMethod,
  readCheckoutApiError,
  validateCheckoutContact,
} from "@/lib/checkout";

type CartPhase =
  | "auth_loading"
  | "claiming_cart"
  | "loading_cart"
  | "empty"
  | "ready"
  | "review_required"
  | "error";

type CheckoutPhase = "idle" | "submitting" | "redirecting";

type CheckoutNotice = {
  message: string;
  retryable: boolean;
};

type CartCheckoutClientProps = {
  redirectToCheckout?: (url: string) => void;
  redirectToConfirmation?: (url: string) => void;
  requestTimeoutMs?: number;
};

const EMPTY_CART: CartView = {
  items: [],
  lineItemCount: 0,
  revision: 0,
  subtotalCents: 0,
  totalQuantity: 0,
  warnings: [],
};

function defaultRedirect(url: string) {
  window.location.assign(url);
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function recoveryToken(body: Record<string, unknown>) {
  for (const key of [
    "checkoutSessionToken",
    "checkoutSessionId",
    "sessionToken",
    "sessionId",
  ]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function cartPhaseFor(cart: CartView): CartPhase {
  if (cart.totalQuantity === 0) {
    return "empty";
  }

  return cartNeedsReview(cart) ? "review_required" : "ready";
}

function LoadingCart({ label }: { label: string }) {
  return (
    <section
      aria-busy="true"
      aria-live="polite"
      className="space-y-5"
    >
      <p className="text-sm font-medium text-slate-600">{label}</p>
      <div aria-hidden="true" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-3">
          <div className="h-36 animate-pulse rounded-lg bg-white/75" />
          <div className="h-36 animate-pulse rounded-lg bg-white/60" />
        </div>
        <div className="h-80 animate-pulse rounded-lg bg-white/75" />
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: CartLine["validationStatus"] }) {
  const valid = status === "valid";

  return (
    <span
      className={`inline-flex min-h-7 items-center rounded-full border px-3 text-xs font-semibold ${
        valid
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-amber-200 bg-amber-50 text-amber-800"
      }`}
    >
      {valid ? "Ready" : "Needs review"}
    </span>
  );
}

function CartLineCard({
  cart,
  isGuest,
  line,
  onRemove,
  onQuantityChange,
  removeError,
  removing,
  updateError,
  updating,
}: {
  cart: CartView;
  isGuest: boolean;
  line: CartLine;
  onRemove: (cartItemId: string) => void;
  onQuantityChange: (line: CartLine, quantity: number) => void;
  removeError: string;
  removing: boolean;
  updateError: string;
  updating: boolean;
}) {
  const issue = getCartLineIssue(cart, line);
  const customization = [
    line.customizationSummary.line1
      ? { label: "Line 1", value: line.customizationSummary.line1 }
      : null,
    line.customizationSummary.line2
      ? { label: "Line 2", value: line.customizationSummary.line2 }
      : null,
    line.customizationSummary.imageAssetId
      ? { label: "Image", value: "Attached" }
      : null,
    line.fabricId ? { label: "Fabric", value: "Selected" } : null,
  ].filter((row) => row !== null);

  return (
    <article className="rounded-lg border border-white/80 bg-white/88 p-5 shadow-[0_16px_45px_rgba(15,23,42,0.07)] sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="break-words text-lg font-semibold text-slate-950">
              {line.title}
            </h3>
            <StatusBadge status={line.validationStatus} />
          </div>
          <p className="text-sm text-slate-500">
            {formatCheckoutMoney(line.unitAmountCents, line.currency)} each
          </p>
        </div>
        <p className="text-base font-semibold text-slate-950">
          {formatCheckoutMoney(
            line.quantity * line.unitAmountCents,
            line.currency,
          )}
        </p>
      </div>

      {customization.length > 0 ? (
        <dl className="mt-5 grid gap-3 border-t border-slate-200/80 pt-4 sm:grid-cols-2">
          {customization.map((row) => (
            <div key={row.label}>
              <dt className="text-xs font-semibold uppercase text-slate-400">
                {row.label}
              </dt>
              <dd className="mt-1 break-words text-sm text-slate-700">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-5 border-t border-slate-200/80 pt-4 text-sm text-slate-500">
          No customization selected.
        </p>
      )}

      {issue ? (
        <div
          className="mt-4 border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900"
          role="alert"
        >
          <p>{issue}</p>
          {!isGuest ? (
            <p className="mt-1">
              Account cart changes are not available here yet. Return to the
              shop or contact Kapchi before checking out.
            </p>
          ) : null}
        </div>
      ) : null}

      {isGuest ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div
            aria-label={`Quantity for ${line.title}`}
            className="grid h-11 grid-cols-[2.75rem_3rem_2.75rem] border border-slate-300 bg-white"
            role="group"
          >
            <button
              aria-label={`Decrease ${line.title} quantity`}
              className="grid place-items-center text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-300"
              disabled={line.quantity <= 1 || removing || updating}
              onClick={() => onQuantityChange(line, line.quantity - 1)}
              title="Decrease quantity"
              type="button"
            >
              <Minus aria-hidden="true" className="h-4 w-4" />
            </button>
            <output
              aria-live="polite"
              className="grid place-items-center border-x border-slate-300 text-sm font-semibold text-slate-950"
            >
              {line.quantity}
            </output>
            <button
              aria-label={`Increase ${line.title} quantity`}
              className="grid place-items-center text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-300"
              disabled={line.quantity >= 999 || removing || updating}
              onClick={() => onQuantityChange(line, line.quantity + 1)}
              title="Increase quantity"
              type="button"
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
          <button
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
            disabled={removing || updating}
            onClick={() => onRemove(line.cartItemId)}
            type="button"
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
            {removing ? "Removing" : "Remove item"}
          </button>
          {removeError || updateError ? (
            <p className="text-sm text-rose-700" role="alert">
              {removeError || updateError}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function CartCheckoutClient({
  redirectToCheckout = defaultRedirect,
  redirectToConfirmation = defaultRedirect,
  requestTimeoutMs = 15_000,
}: CartCheckoutClientProps) {
  const { getToken, isLoaded: authLoaded, isSignedIn, userId } = useAuth();
  const { user } = useUser();
  const signedIn = Boolean(isSignedIn);
  const [cart, setCart] = useState<CartView | null>(null);
  const [cartPhase, setCartPhase] = useState<CartPhase>("auth_loading");
  const [loadError, setLoadError] = useState("");
  const [claimNotice, setClaimNotice] = useState("");
  const [removingId, setRemovingId] = useState("");
  const [removeError, setRemoveError] = useState<{
    cartItemId: string;
    message: string;
  } | null>(null);
  const [updatingId, setUpdatingId] = useState("");
  const [updateError, setUpdateError] = useState<{
    cartItemId: string;
    message: string;
  } | null>(null);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [preferredContactMethod, setPreferredContactMethod] =
    useState<PreferredContactMethod>("email");
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    phone?: string;
  }>({});
  const [checkoutPhase, setCheckoutPhase] =
    useState<CheckoutPhase>("idle");
  const [checkoutNotice, setCheckoutNotice] =
    useState<CheckoutNotice | null>(null);
  const loadSequence = useRef(0);
  const cartGeneration = useRef(0);
  const cartOwner = useRef<string | null>(null);
  const cartRevision = useRef(-1);
  const submitGuard = useRef(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const checkoutNoticeRef = useRef<HTMLDivElement>(null);

  const accountEmail = user?.primaryEmailAddress?.emailAddress?.trim() ?? "";

  const commitCart = useCallback((nextCart: CartView, generation: number) => {
    if (
      generation !== cartGeneration.current ||
      nextCart.revision < cartRevision.current
    ) {
      return false;
    }

    cartRevision.current = nextCart.revision;
    setCart(nextCart);
    setCartPhase(cartPhaseFor(nextCart));
    return true;
  }, []);

  const clearMissingCart = useCallback(() => {
    loadSequence.current += 1;
    cartGeneration.current += 1;
    cartRevision.current = 0;
    setCart(EMPTY_CART);
    setCartPhase("empty");
    publishCartInvalidation();
  }, []);

  useEffect(() => {
    if (signedIn && accountEmail) {
      setEmail((current) => current || accountEmail);
    }
  }, [accountEmail, signedIn]);

  const loadCart = useCallback(async () => {
    if (!authLoaded) {
      setCartPhase("auth_loading");
      return;
    }

    const ownerKey = signedIn ? `account:${userId ?? "unknown"}` : "guest";
    if (cartOwner.current !== ownerKey) {
      cartOwner.current = ownerKey;
      cartGeneration.current += 1;
      cartRevision.current = -1;
      setCart(null);
    }

    const sequence = ++loadSequence.current;
    const generation = cartGeneration.current;
    setLoadError("");
    setClaimNotice("");
    setRemoveError(null);
    setUpdateError(null);

    try {
      let headers: HeadersInit | undefined;
      let loadedCart: CartView | null = null;

      if (signedIn) {
        setCartPhase("claiming_cart");
        const token = await getToken();
        if (!token) {
          throw new CheckoutApiError(
            "UNAUTHORIZED",
            401,
            "Account session unavailable.",
          );
        }
        headers = { Authorization: `Bearer ${token}` };

        try {
          const claimResponse = await fetchWithTimeout(
            buildApiUrl("/cart/claim"),
            {
              credentials: "include",
              headers,
              method: "POST",
            },
            requestTimeoutMs,
          );

          if (!claimResponse.ok) {
            const claimError = await readCheckoutApiError(claimResponse);
            if (claimError.code !== "CART_NOT_FOUND") {
              setClaimNotice(
                claimError.code === "CART_CLAIM_CONFLICT"
                  ? checkoutErrorMessage(claimError)
                  : "We could not merge a guest cart into your account. Your account cart is shown below.",
              );
            }
          } else {
            loadedCart = parseCartView(await claimResponse.json());
            publishCartInvalidation();
          }
        } catch {
          setClaimNotice(
            "We could not merge a guest cart into your account. Your account cart is shown below.",
          );
        }
      }

      if (!loadedCart) {
        setCartPhase("loading_cart");
        const response = await fetchWithTimeout(
          buildApiUrl("/cart/"),
          {
            cache: "no-store",
            credentials: "include",
            headers,
          },
          requestTimeoutMs,
        );

        if (!response.ok) {
          throw await readCheckoutApiError(response);
        }

        loadedCart = parseCartView(await response.json());
      }

      if (sequence !== loadSequence.current) {
        return;
      }

      commitCart(loadedCart, generation);
    } catch (error) {
      if (sequence !== loadSequence.current) {
        return;
      }

      if (error instanceof CheckoutApiError && error.code === "CART_NOT_FOUND") {
        clearMissingCart();
        return;
      }

      setCart(null);
      setCartPhase("error");
      setLoadError(
        error instanceof CheckoutApiError && error.code === "UNAUTHORIZED"
          ? checkoutErrorMessage(error)
          : "We could not load your cart. Check your connection and try again.",
      );
    }
  }, [
    authLoaded,
    clearMissingCart,
    commitCart,
    getToken,
    requestTimeoutMs,
    signedIn,
    userId,
  ]);

  useEffect(() => {
    void loadCart();

    return () => {
      loadSequence.current += 1;
    };
  }, [loadCart]);

  useEffect(() => {
    if (checkoutNotice) {
      checkoutNoticeRef.current?.focus();
    }
  }, [checkoutNotice]);

  const needsReview = useMemo(
    () => Boolean(cart && cartNeedsReview(cart)),
    [cart],
  );

  async function removeItem(cartItemId: string) {
    if (signedIn || removingId || updatingId) {
      return;
    }

    setRemovingId(cartItemId);
    setRemoveError(null);
    const generation = cartGeneration.current;
    let receivedResponse = false;

    try {
      const response = await fetchWithTimeout(
        buildApiUrl(`/cart/items/${encodeURIComponent(cartItemId)}`),
        {
          credentials: "include",
          method: "DELETE",
        },
        requestTimeoutMs,
      );
      receivedResponse = true;

      if (!response.ok) {
        throw await readCheckoutApiError(response);
      }

      const updatedCart = parseCartView(await response.json());
      commitCart(updatedCart, generation);
      publishCartInvalidation();
    } catch (error) {
      if (error instanceof CheckoutApiError && error.code === "CART_NOT_FOUND") {
        clearMissingCart();
      } else {
        if (!receivedResponse) {
          publishCartInvalidation();
        }
        setRemoveError({
          cartItemId,
          message: "We could not remove this item. Try again.",
        });
      }
    } finally {
      setRemovingId("");
    }
  }

  async function updateItemQuantity(line: CartLine, quantity: number) {
    if (signedIn || removingId || updatingId) {
      return;
    }

    setUpdatingId(line.cartItemId);
    setUpdateError(null);
    const generation = cartGeneration.current;
    let receivedResponse = false;

    try {
      const response = await fetchWithTimeout(
        buildApiUrl(`/cart/items/${encodeURIComponent(line.cartItemId)}`),
        {
          body: JSON.stringify(buildCartItemMutation(line, quantity)),
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        },
        requestTimeoutMs,
      );
      receivedResponse = true;

      if (!response.ok) {
        throw await readCheckoutApiError(response);
      }

      const updatedCart = parseCartView(await response.json());
      commitCart(updatedCart, generation);
      publishCartInvalidation();
    } catch (error) {
      if (error instanceof CheckoutApiError && error.code === "CART_NOT_FOUND") {
        clearMissingCart();
      } else {
        if (!receivedResponse) {
          publishCartInvalidation();
        }
        setUpdateError({
          cartItemId: line.cartItemId,
          message: "We could not update this quantity. Try again.",
        });
      }
    } finally {
      setUpdatingId("");
    }
  }

  async function handleCheckout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (
      submitGuard.current ||
      !cart ||
      cart.totalQuantity === 0 ||
      needsReview ||
      Boolean(removingId) ||
      Boolean(updatingId)
    ) {
      return;
    }

    submitGuard.current = true;
    const errors = validateCheckoutContact({
      customerEmail: email,
      customerPhone: phone,
      isSignedIn: signedIn,
      preferredContactMethod,
    });

    if (errors.email || errors.phone) {
      setFieldErrors(errors);
      setCheckoutNotice(null);
      submitGuard.current = false;
      window.setTimeout(() => {
        if (errors.email) {
          emailInputRef.current?.focus();
        } else {
          phoneInputRef.current?.focus();
        }
      }, 0);
      return;
    }

    setFieldErrors({});
    setCheckoutNotice(null);
    setCheckoutPhase("submitting");
    let redirecting = false;

    try {
      let headers: HeadersInit = { "Content-Type": "application/json" };
      if (signedIn) {
        const token = await getToken();
        if (!token) {
          throw new CheckoutApiError(
            "UNAUTHORIZED",
            401,
            "Account session unavailable.",
          );
        }
        headers = {
          ...headers,
          Authorization: `Bearer ${token}`,
        };
      }

      const response = await fetchWithTimeout(
        buildApiUrl("/payments/checkout-sessions"),
        {
          body: JSON.stringify({
            ...(cart.cartId
              ? { cartId: cart.cartId, cartRevision: cart.revision }
              : {}),
            customerEmail: email.trim(),
            customerPhone: phone.trim() || null,
            preferredContactMethod,
          }),
          credentials: "include",
          headers,
          method: "POST",
        },
        requestTimeoutMs,
      );

      if (!response.ok) {
        throw await readCheckoutApiError(response);
      }

      const result = (await response.json()) as { url?: unknown };
      const checkoutUrl = getSafeHostedCheckoutUrl(result.url);
      if (!checkoutUrl) {
        throw new CheckoutApiError(
          "INVALID_CHECKOUT_URL",
          200,
          "Invalid hosted checkout URL.",
        );
      }

      redirecting = true;
      setCheckoutPhase("redirecting");
      redirectToCheckout(checkoutUrl);
    } catch (error) {
      if (
        error instanceof CheckoutApiError &&
        error.code === "CART_NEEDS_REVIEW"
      ) {
        await loadCart();
      }

      if (
        error instanceof CheckoutApiError &&
        error.code === "CART_NOT_FOUND"
      ) {
        clearMissingCart();
      }

      if (
        error instanceof CheckoutApiError &&
        error.code === "CHECKOUT_ALREADY_COMPLETE"
      ) {
        const token = recoveryToken(error.responseBody);
        if (token) {
          redirecting = true;
          setCheckoutPhase("redirecting");
          redirectToConfirmation(
            `/checkout/confirmation?checkout_session_id=${encodeURIComponent(token)}`,
          );
          return;
        }
      }

      setCheckoutNotice({
        message: checkoutErrorMessage(error),
        retryable: isRetryableCheckoutError(error),
      });
    } finally {
      if (!redirecting) {
        submitGuard.current = false;
        setCheckoutPhase("idle");
      }
    }
  }

  if (
    cartPhase === "auth_loading" ||
    cartPhase === "claiming_cart" ||
    cartPhase === "loading_cart"
  ) {
    const label =
      cartPhase === "claiming_cart"
        ? "Checking for items to add to your account cart..."
        : cartPhase === "auth_loading"
          ? "Preparing your cart..."
          : "Loading your cart...";

    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-10 sm:px-8 sm:py-14">
        <header className="mb-8 space-y-2">
          <p className="text-sm font-semibold uppercase text-[#8f734f]">Cart</p>
          <h1 className="text-3xl font-semibold text-slate-950 sm:text-4xl">
            Review and checkout
          </h1>
        </header>
        <LoadingCart label={label} />
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-10 sm:px-8 sm:py-14">
      <header className="mb-8 space-y-2">
        <p className="text-sm font-semibold uppercase text-[#8f734f]">Cart</p>
        <h1 className="text-3xl font-semibold text-slate-950 sm:text-4xl">
          Review and checkout
        </h1>
        <p className="max-w-2xl text-base leading-7 text-slate-600">
          Confirm each item and tell us how to contact you before continuing to
          secure payment.
        </p>
      </header>

      {claimNotice ? (
        <div
          className="mb-6 border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900"
          role="alert"
        >
          {claimNotice}
        </div>
      ) : null}

      {cartPhase === "error" ? (
        <section
          className="rounded-lg border border-rose-200 bg-white/85 p-6 shadow-[0_16px_45px_rgba(15,23,42,0.07)]"
          role="alert"
        >
          <h2 className="text-lg font-semibold text-slate-950">
            Your cart is unavailable
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">{loadError}</p>
          <button
            className="mt-5 min-h-11 rounded-lg bg-[#b49872] px-5 text-sm font-semibold text-white transition hover:bg-[#a1845f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2"
            onClick={() => void loadCart()}
            type="button"
          >
            Retry cart
          </button>
        </section>
      ) : cartPhase === "empty" || !cart ? (
        <section className="rounded-lg border border-white/80 bg-white/88 p-8 text-center shadow-[0_16px_45px_rgba(15,23,42,0.07)] sm:p-12">
          <h2 className="text-2xl font-semibold text-slate-950">
            Your cart is empty
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-slate-600">
            Your cart may have expired, or you have not added an item yet.
          </p>
          <Link
            className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-[#b49872] px-5 text-sm font-semibold text-white transition hover:bg-[#a1845f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2"
            href="/"
          >
            Continue shopping
          </Link>
        </section>
      ) : (
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <section aria-labelledby="cart-items-title" className="min-w-0">
            <div className="mb-4 flex items-end justify-between gap-4">
              <div>
                <h2
                  className="text-xl font-semibold text-slate-950"
                  id="cart-items-title"
                >
                  Your items
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {cart.totalQuantity}{" "}
                  {cart.totalQuantity === 1 ? "item" : "items"}
                </p>
              </div>
              <button
                className="min-h-11 rounded-lg px-3 text-sm font-semibold text-[#8f734f] underline decoration-[#b49872]/40 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872]"
                onClick={() => void loadCart()}
                type="button"
              >
                Refresh cart
              </button>
            </div>

            {needsReview ? (
              <div
                className="mb-4 border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900"
                role="alert"
              >
                <p className="font-semibold">Review required</p>
                <p>
                  Checkout is paused until every affected item is resolved.
                </p>
              </div>
            ) : null}

            <div className="space-y-4">
              {cart.items.map((line) => (
                <CartLineCard
                  cart={cart}
                  isGuest={!signedIn}
                  key={line.cartItemId}
                  line={line}
                  onRemove={(cartItemId) => void removeItem(cartItemId)}
                  onQuantityChange={(cartLine, quantity) =>
                    void updateItemQuantity(cartLine, quantity)
                  }
                  removeError={
                    removeError?.cartItemId === line.cartItemId
                      ? removeError.message
                      : ""
                  }
                  removing={removingId === line.cartItemId}
                  updateError={
                    updateError?.cartItemId === line.cartItemId
                      ? updateError.message
                      : ""
                  }
                  updating={updatingId === line.cartItemId}
                />
              ))}
            </div>
          </section>

          <aside className="rounded-lg border border-white/80 bg-white/92 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.09)] sm:p-6 lg:sticky lg:top-28">
            <form
              aria-busy={checkoutPhase !== "idle"}
              className="space-y-5"
              noValidate
              onSubmit={handleCheckout}
            >
              <div className="flex items-baseline justify-between gap-4 border-b border-slate-200 pb-5">
                <h2 className="text-lg font-semibold text-slate-950">
                  Order subtotal
                </h2>
                <p className="text-lg font-semibold text-slate-950">
                  {formatCheckoutMoney(
                    cart.subtotalCents,
                    cart.items[0]?.currency ?? "USD",
                  )}
                </p>
              </div>

              <div className="space-y-2">
                <label
                  className="block text-sm font-semibold text-slate-700"
                  htmlFor="checkout-email"
                >
                  Email
                </label>
                <input
                  aria-describedby={
                    fieldErrors.email ? "checkout-email-error" : undefined
                  }
                  aria-invalid={Boolean(fieldErrors.email)}
                  autoComplete="email"
                  className="h-12 w-full rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-[#b49872] focus:ring-2 focus:ring-[#b49872]/20"
                  id="checkout-email"
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setFieldErrors((current) => ({ ...current, email: undefined }));
                  }}
                  placeholder="you@example.com"
                  ref={emailInputRef}
                  type="email"
                  value={email}
                />
                {fieldErrors.email ? (
                  <p
                    className="text-sm text-rose-700"
                    id="checkout-email-error"
                  >
                    {fieldErrors.email}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <label
                  className="block text-sm font-semibold text-slate-700"
                  htmlFor="checkout-phone"
                >
                  Phone
                </label>
                <input
                  aria-describedby={
                    fieldErrors.phone
                      ? "checkout-phone-error"
                      : signedIn && preferredContactMethod === "email"
                        ? "checkout-phone-hint"
                        : undefined
                  }
                  aria-invalid={Boolean(fieldErrors.phone)}
                  autoComplete="tel"
                  className="h-12 w-full rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-[#b49872] focus:ring-2 focus:ring-[#b49872]/20"
                  id="checkout-phone"
                  onChange={(event) => {
                    setPhone(event.target.value);
                    setFieldErrors((current) => ({ ...current, phone: undefined }));
                  }}
                  placeholder="(555) 123-4567"
                  ref={phoneInputRef}
                  type="tel"
                  value={phone}
                />
                {fieldErrors.phone ? (
                  <p
                    className="text-sm text-rose-700"
                    id="checkout-phone-error"
                  >
                    {fieldErrors.phone}
                  </p>
                ) : signedIn && preferredContactMethod === "email" ? (
                  <p className="text-xs leading-5 text-slate-500" id="checkout-phone-hint">
                    Optional when email is preferred.
                  </p>
                ) : null}
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold text-slate-700">
                  Preferred contact method
                </legend>
                <div className="grid grid-cols-2 rounded-lg border border-slate-300 bg-slate-50 p-1">
                  {(["email", "phone"] as const).map((method) => (
                    <label
                      className={`flex min-h-10 cursor-pointer items-center justify-center rounded-md px-3 text-sm font-semibold capitalize transition ${
                        preferredContactMethod === method
                          ? "bg-white text-[#8f734f] shadow-sm"
                          : "text-slate-500 hover:text-slate-800"
                      }`}
                      key={method}
                    >
                      <input
                        checked={preferredContactMethod === method}
                        className="sr-only"
                        name="preferred-contact-method"
                        onChange={() => setPreferredContactMethod(method)}
                        type="radio"
                        value={method}
                      />
                      {method}
                    </label>
                  ))}
                </div>
              </fieldset>

              {needsReview ? (
                <p className="bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-900">
                  Resolve the item issues before continuing to payment.
                </p>
              ) : null}

              {checkoutNotice ? (
                <div
                  className="border-l-4 border-rose-400 bg-rose-50 px-3 py-3 text-sm leading-6 text-rose-800 outline-none"
                  ref={checkoutNoticeRef}
                  role="alert"
                  tabIndex={-1}
                >
                  <p>{checkoutNotice.message}</p>
                  {checkoutNotice.retryable ? (
                    <button
                      className="mt-2 min-h-10 font-semibold underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                      disabled={Boolean(removingId) || Boolean(updatingId)}
                      type="submit"
                    >
                      Try checkout again
                    </button>
                  ) : null}
                </div>
              ) : null}

              <button
                className="flex min-h-12 w-full items-center justify-center rounded-lg bg-[#b49872] px-5 text-base font-semibold text-white transition hover:bg-[#a1845f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
                disabled={
                  needsReview ||
                  checkoutPhase !== "idle" ||
                  Boolean(removingId) ||
                  Boolean(updatingId)
                }
                type="submit"
              >
                {checkoutPhase === "submitting"
                  ? "Starting checkout"
                  : checkoutPhase === "redirecting"
                    ? "Opening secure checkout"
                    : "Continue to secure checkout"}
              </button>

              <p className="text-center text-xs leading-5 text-slate-500">
                Payment is completed securely on Stripe.
              </p>
            </form>
          </aside>
        </div>
      )}
    </main>
  );
}
