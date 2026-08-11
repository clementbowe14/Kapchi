"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { buildApiUrl } from "@/lib/api";
import {
  CheckoutApiError,
  type CheckoutStatusResult,
  readCheckoutApiError,
} from "@/lib/checkout";

type ConfirmationPhase =
  | "auth_loading"
  | "confirming"
  | "pending"
  | "paid"
  | "failed"
  | "error"
  | "missing";

type CheckoutConfirmationClientProps = {
  checkoutSessionId: string | null;
  pollDelaysMs?: readonly number[];
  requestTimeoutMs?: number;
};

const DEFAULT_POLL_DELAYS_MS = [0, 1_000, 2_000, 3_000, 5_000] as const;
const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]{3,252}$/;
const PAID_STATUSES = new Set(["paid", "no_payment_required"]);
const FAILED_STATUSES = new Set([
  "cancelled",
  "canceled",
  "expired",
  "failed",
  "refunded",
]);

function isStatusResult(value: unknown): value is CheckoutStatusResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const result = value as Record<string, unknown>;
  return (
    typeof result.orderId === "string" &&
    Boolean(result.orderId) &&
    typeof result.publicOrderNumber === "string" &&
    Boolean(result.publicOrderNumber) &&
    typeof result.paymentStatus === "string" &&
    Boolean(result.paymentStatus)
  );
}

function statusErrorMessage(error: unknown) {
  if (error instanceof CheckoutApiError) {
    if (error.code === "CHECKOUT_NOT_FOUND" || error.status === 404) {
      return "We could not verify this checkout for the current customer. Return to your orders or cart for help.";
    }
    if (error.status === 401 || error.status === 403) {
      return "Your account session could not be verified. Sign in again, then retry.";
    }
    if (error.status >= 500) {
      return "Payment status is temporarily unavailable. You can retry without being charged again.";
    }
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return "Payment status took too long to respond. You can retry safely.";
  }

  return "We could not reach payment status. Check your connection and try again.";
}

function isRetryableStatusError(error: unknown) {
  return !(
    error instanceof CheckoutApiError &&
    (error.code === "CHECKOUT_NOT_FOUND" ||
      error.status === 400 ||
      error.status === 404)
  );
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

function OrderIdentity({ status }: { status: CheckoutStatusResult }) {
  return (
    <dl className="mt-6 grid gap-3 sm:grid-cols-2">
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        <dt className="text-xs font-semibold uppercase text-slate-400">
          Order number
        </dt>
        <dd className="mt-1 break-words text-sm font-semibold text-slate-950">
          {status.publicOrderNumber}
        </dd>
      </div>
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        <dt className="text-xs font-semibold uppercase text-slate-400">
          Order ID
        </dt>
        <dd className="mt-1 break-all text-sm font-medium text-slate-800">
          {status.orderId}
        </dd>
      </div>
    </dl>
  );
}

export function CheckoutConfirmationClient({
  checkoutSessionId,
  pollDelaysMs = DEFAULT_POLL_DELAYS_MS,
  requestTimeoutMs = 15_000,
}: CheckoutConfirmationClientProps) {
  const { getToken, isLoaded: authLoaded, isSignedIn } = useAuth();
  const signedIn = Boolean(isSignedIn);
  const [phase, setPhase] = useState<ConfirmationPhase>(
    authLoaded ? "confirming" : "auth_loading",
  );
  const [status, setStatus] = useState<CheckoutStatusResult | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [errorRetryable, setErrorRetryable] = useState(false);
  const [pollingComplete, setPollingComplete] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const statusRegionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!authLoaded) {
      setPhase("auth_loading");
      return;
    }

    if (!checkoutSessionId || !SESSION_ID_PATTERN.test(checkoutSessionId)) {
      setPhase("missing");
      setStatus(null);
      return;
    }

    let cancelled = false;
    let pollTimer: number | undefined;
    setPhase("confirming");
    setStatus(null);
    setErrorMessage("");
    setErrorRetryable(false);
    setPollingComplete(false);

    async function readStatus(attempt: number) {
      try {
        let headers: HeadersInit | undefined;
        if (signedIn) {
          const token = await getToken();
          if (!token) {
            throw new CheckoutApiError(
              "UNAUTHORIZED",
              401,
              "Account session unavailable.",
            );
          }
          headers = { Authorization: `Bearer ${token}` };
        }

        const response = await fetchWithTimeout(
          buildApiUrl(
            `/payments/checkout-sessions/${encodeURIComponent(checkoutSessionId!)}/status`,
          ),
          {
            credentials: "same-origin",
            headers,
          },
          requestTimeoutMs,
        );

        if (!response.ok) {
          throw await readCheckoutApiError(response);
        }

        const result: unknown = await response.json();
        if (!isStatusResult(result)) {
          throw new CheckoutApiError(
            "INVALID_STATUS_RESPONSE",
            502,
            "Invalid checkout status response.",
          );
        }

        if (cancelled) {
          return;
        }

        setStatus(result);
        const normalizedStatus = result.paymentStatus.toLowerCase();
        if (PAID_STATUSES.has(normalizedStatus)) {
          setPhase("paid");
          return;
        }
        if (FAILED_STATUSES.has(normalizedStatus)) {
          setPhase("failed");
          return;
        }

        setPhase("pending");
        const nextAttempt = attempt + 1;
        if (nextAttempt < pollDelaysMs.length) {
          pollTimer = window.setTimeout(
            () => void readStatus(nextAttempt),
            pollDelaysMs[nextAttempt],
          );
        } else {
          setPollingComplete(true);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        setPhase("error");
        setErrorMessage(statusErrorMessage(error));
        setErrorRetryable(isRetryableStatusError(error));
      }
    }

    void readStatus(0);

    return () => {
      cancelled = true;
      if (pollTimer !== undefined) {
        window.clearTimeout(pollTimer);
      }
    };
  }, [
    authLoaded,
    checkoutSessionId,
    getToken,
    pollDelaysMs,
    requestTimeoutMs,
    retryKey,
    signedIn,
  ]);

  useEffect(() => {
    if (phase !== "auth_loading" && phase !== "confirming") {
      statusRegionRef.current?.focus();
    }
  }, [phase, pollingComplete]);

  const busy = phase === "auth_loading" || phase === "confirming";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 items-center px-5 py-12 sm:px-8 sm:py-16">
      <section
        aria-busy={busy}
        aria-live="polite"
        className="w-full rounded-lg border border-white/80 bg-white/90 p-7 shadow-[0_20px_60px_rgba(15,23,42,0.09)] outline-none sm:p-10"
        ref={statusRegionRef}
        tabIndex={-1}
      >
        <p className="text-sm font-semibold uppercase text-[#8f734f]">
          Checkout confirmation
        </p>

        {busy ? (
          <div className="mt-4 space-y-3">
            <h1 className="text-3xl font-semibold text-slate-950">
              Confirming your payment
            </h1>
            <p className="text-base leading-7 text-slate-600">
              This usually takes only a moment. Keep this page open while we
              verify your order.
            </p>
          </div>
        ) : phase === "paid" && status ? (
          <div className="mt-4">
            <h1 className="text-3xl font-semibold text-slate-950">
              Payment confirmed
            </h1>
            <p className="mt-3 text-base leading-7 text-slate-600">
              Thank you. Your Kapchi order has been received.
            </p>
            <OrderIdentity status={status} />
          </div>
        ) : phase === "pending" && status ? (
          <div className="mt-4">
            <h1 className="text-3xl font-semibold text-slate-950">
              Payment is processing
            </h1>
            <p className="mt-3 text-base leading-7 text-slate-600">
              Your order is verified, but payment confirmation is still on its
              way. You do not need to submit checkout again.
            </p>
            <OrderIdentity status={status} />
            {pollingComplete ? (
              <button
                className="mt-6 min-h-11 rounded-lg bg-[#b49872] px-5 text-sm font-semibold text-white transition hover:bg-[#a1845f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2"
                onClick={() => setRetryKey((current) => current + 1)}
                type="button"
              >
                Check payment again
              </button>
            ) : (
              <p className="mt-5 text-sm font-medium text-[#8f734f]">
                Checking again automatically...
              </p>
            )}
          </div>
        ) : phase === "failed" && status ? (
          <div className="mt-4">
            <h1 className="text-3xl font-semibold text-slate-950">
              Payment was not completed
            </h1>
            <p className="mt-3 text-base leading-7 text-slate-600">
              Your order was found, but payment is not complete. Return to your
              cart before attempting checkout again.
            </p>
            <OrderIdentity status={status} />
          </div>
        ) : phase === "missing" ? (
          <div className="mt-4" role="alert">
            <h1 className="text-3xl font-semibold text-slate-950">
              Confirmation link incomplete
            </h1>
            <p className="mt-3 text-base leading-7 text-slate-600">
              This return link does not include a valid checkout reference.
              Open your orders or cart to continue.
            </p>
          </div>
        ) : (
          <div className="mt-4" role="alert">
            <h1 className="text-3xl font-semibold text-slate-950">
              We could not confirm payment
            </h1>
            <p className="mt-3 text-base leading-7 text-slate-600">
              {errorMessage}
            </p>
            {errorRetryable ? (
              <button
                className="mt-6 min-h-11 rounded-lg bg-[#b49872] px-5 text-sm font-semibold text-white transition hover:bg-[#a1845f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2"
                onClick={() => setRetryKey((current) => current + 1)}
                type="button"
              >
                Retry confirmation
              </button>
            ) : null}
          </div>
        )}

        {!busy ? (
          <nav className="mt-8 flex flex-wrap gap-4 border-t border-slate-200 pt-5" aria-label="Order actions">
            <Link
              className="text-sm font-semibold text-[#8f734f] underline decoration-[#b49872]/40 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872]"
              href="/orders"
            >
              View orders
            </Link>
            <Link
              className="text-sm font-semibold text-slate-600 underline decoration-slate-300 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872]"
              href="/cart"
            >
              Return to cart
            </Link>
          </nav>
        ) : null}
      </section>
    </main>
  );
}
