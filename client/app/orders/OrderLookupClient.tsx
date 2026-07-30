"use client";

import { ClerkLoaded, ClerkLoading, useAuth, useUser } from "@clerk/nextjs";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { buildApiUrl } from "@/lib/api";

export type CustomerOrderItem = {
  id: string;
  quantity: number;
  unitAmountCents: number;
  totalAmountCents: number;
  currency: string;
  listingSnapshot: unknown;
  fabricSnapshot?: unknown;
  customizationSummary: unknown;
};

export type CustomerOrder = {
  id: string;
  publicOrderNumber: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  totalCents: number;
  currency: string;
  createdAt: string;
  paidAt?: string | null;
  items: CustomerOrderItem[];
  tracking?: {
    carrier?: string | null;
    trackingNumber?: string | null;
    trackingUrl?: string | null;
  } | null;
};

type ContactMethod = "email" | "phone";
type RequestState = "idle" | "loading" | "success" | "error";

const SENSITIVE_KEY_PATTERN =
  /(admin|internal|metadata|secret|token|stripe|paymentintent|payment_intent|clerk|userid|user_id|customerid|customer_id|note|notes)/i;

function humanizeKey(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getStringField(value: unknown, keys: string[]) {
  if (!isRecord(value)) {
    return null;
  }

  for (const key of keys) {
    const field = value[key];

    if (typeof field === "string" && field.trim()) {
      return field.trim();
    }
  }

  return null;
}

export function formatOrderMoney(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    currency,
    style: "currency",
  }).format(cents / 100);
}

export function formatOrderDate(value?: string | null) {
  if (!value) {
    return "Not available";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function getOrderItemTitle(item: CustomerOrderItem) {
  return (
    getStringField(item.listingSnapshot, ["title", "name", "label"]) ??
    "Kapchi item"
  );
}

export function getOrderSummaryRows(value: unknown, limit = 8) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [{ label: "Details", value: trimmed }] : [];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [{ label: "Details", value: String(value) }];
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, limit)
      .map((entry, index) => ({
        label: `Option ${index + 1}`,
        value: stringifySummaryValue(entry),
      }))
      .filter((row) => row.value);
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value)
    .filter(([key]) => !SENSITIVE_KEY_PATTERN.test(key))
    .map(([key, entry]) => ({
      label: humanizeKey(key),
      value: stringifySummaryValue(entry),
    }))
    .filter((row) => row.value)
    .slice(0, limit);
}

function stringifySummaryValue(value: unknown): string {
  if (value === null || typeof value === "undefined") {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(stringifySummaryValue).filter(Boolean).join(", ");
  }

  if (isRecord(value)) {
    return Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEY_PATTERN.test(key))
      .map(([key, entry]) => {
        const summary = stringifySummaryValue(entry);
        return summary ? `${humanizeKey(key)}: ${summary}` : "";
      })
      .filter(Boolean)
      .join(", ");
  }

  return "";
}

async function readError(response: Response) {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    const message = body.message ?? body.error;

    if (typeof message === "string" && message.trim()) {
      return message;
    }
  } catch {
    // Fall through to generic customer-safe copy.
  }

  return response.status === 404
    ? "We could not find an order matching those details."
    : "Something went wrong while loading your order.";
}

function StatusPill({ children }: { children: string }) {
  return (
    <span className="inline-flex min-h-7 items-center rounded-full border border-[#b49872]/25 bg-[#b49872]/12 px-3 text-xs font-semibold capitalize text-[#8f734f]">
      {children.replace(/_/g, " ")}
    </span>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="text-base font-semibold tracking-tight text-slate-950">
      {children}
    </h2>
  );
}

function FieldLabel({
  children,
  htmlFor,
}: {
  children: string;
  htmlFor: string;
}) {
  return (
    <label className="text-sm font-semibold text-slate-700" htmlFor={htmlFor}>
      {children}
    </label>
  );
}

function EmptyPanel({ children }: { children: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-white/55 px-5 py-6 text-sm leading-6 text-slate-500">
      {children}
    </div>
  );
}

function OrderCard({ order }: { order: CustomerOrder }) {
  const tracking = order.tracking;

  return (
    <article className="space-y-6 rounded-3xl border border-white/70 bg-white/82 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <p className="break-words text-sm font-semibold uppercase tracking-[0.18em] text-[#8f734f]">
            {order.publicOrderNumber || order.id}
          </p>
          <h3 className="text-2xl font-semibold tracking-tight text-slate-950">
            {formatOrderMoney(order.totalCents, order.currency)}
          </h3>
          <p className="text-sm text-slate-500">
            Placed {formatOrderDate(order.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill>{order.status}</StatusPill>
          <StatusPill>{order.paymentStatus}</StatusPill>
          <StatusPill>{order.fulfillmentStatus}</StatusPill>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <InfoCell label="Email" value={order.customerEmail ?? "Not provided"} />
        <InfoCell label="Phone" value={order.customerPhone ?? "Not provided"} />
        <InfoCell label="Paid" value={formatOrderDate(order.paidAt)} />
        <InfoCell
          label="Tracking"
          value={
            tracking?.trackingNumber
              ? [tracking.carrier, tracking.trackingNumber].filter(Boolean).join(" ")
              : "Not available"
          }
          href={tracking?.trackingUrl ?? undefined}
        />
      </div>

      <div className="space-y-3">
        <SectionTitle>Purchased Items</SectionTitle>
        <div className="divide-y divide-slate-200/70 overflow-hidden rounded-2xl border border-slate-200/80 bg-white/70">
          {order.items.length > 0 ? (
            order.items.map((item) => <OrderItemRow item={item} key={item.id} />)
          ) : (
            <div className="px-4 py-5 text-sm text-slate-500">
              No item details are available for this order.
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function InfoCell({
  href,
  label,
  value,
}: {
  href?: string;
  label: string;
  value: string;
}) {
  const valueClassName = "break-words text-sm font-medium text-slate-900";

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-slate-50/80 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
        {label}
      </p>
      {href ? (
        <a
          className={`${valueClassName} underline decoration-[#b49872]/45 underline-offset-4 transition hover:text-[#8f734f]`}
          href={href}
          rel="noreferrer"
          target="_blank"
        >
          {value}
        </a>
      ) : (
        <p className={valueClassName}>{value}</p>
      )}
    </div>
  );
}

function OrderItemRow({ item }: { item: CustomerOrderItem }) {
  const customizationRows = getOrderSummaryRows(item.customizationSummary);
  const fabricRows = getOrderSummaryRows(item.fabricSnapshot, 3);

  return (
    <div className="space-y-4 px-4 py-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="break-words text-base font-semibold text-slate-950">
            {getOrderItemTitle(item)}
          </p>
          <p className="text-sm text-slate-500">
            Qty {item.quantity} at{" "}
            {formatOrderMoney(item.unitAmountCents, item.currency)}
          </p>
        </div>
        <p className="text-sm font-semibold text-[#8f734f]">
          {formatOrderMoney(item.totalAmountCents, item.currency)}
        </p>
      </div>

      {customizationRows.length > 0 ? (
        <SummaryGrid rows={customizationRows} title="Customization" />
      ) : (
        <p className="text-sm text-slate-500">No customization summary.</p>
      )}

      {fabricRows.length > 0 ? (
        <SummaryGrid rows={fabricRows} title="Fabric" />
      ) : null}
    </div>
  );
}

function SummaryGrid({
  rows,
  title,
}: {
  rows: Array<{ label: string; value: string }>;
  title: string;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
        {title}
      </p>
      <dl className="grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div
            className="rounded-xl border border-slate-200/70 bg-white/70 px-3 py-2"
            key={`${row.label}-${row.value}`}
          >
            <dt className="text-xs font-semibold text-slate-500">
              {row.label}
            </dt>
            <dd className="break-words text-sm text-slate-800">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function OrdersSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <span className="block h-5 w-44 animate-pulse rounded-full bg-slate-200" />
      <span className="block h-32 w-full animate-pulse rounded-3xl bg-slate-100" />
    </div>
  );
}

export function OrderLookupClient() {
  const { getToken, isLoaded: authLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const [contactMethod, setContactMethod] = useState<ContactMethod>("email");
  const [orderId, setOrderId] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [lookupState, setLookupState] = useState<RequestState>("idle");
  const [lookupError, setLookupError] = useState("");
  const [lookupOrder, setLookupOrder] = useState<CustomerOrder | null>(null);
  const [historyState, setHistoryState] = useState<RequestState>("idle");
  const [historyError, setHistoryError] = useState("");
  const [historyOrders, setHistoryOrders] = useState<CustomerOrder[]>([]);

  const accountLabel = useMemo(() => {
    return user?.primaryEmailAddress?.emailAddress ?? user?.username ?? "your account";
  }, [user]);

  useEffect(() => {
    let cancelled = false;

    async function loadHistory() {
      if (!authLoaded || !isSignedIn) {
        setHistoryState("idle");
        setHistoryOrders([]);
        return;
      }

      setHistoryState("loading");
      setHistoryError("");

      try {
        const token = await getToken();
        const response = await fetch(buildApiUrl("/orders/me"), {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });

        if (!response.ok) {
          throw new Error(await readError(response));
        }

        const body = (await response.json()) as
          | CustomerOrder[]
          | { orders?: CustomerOrder[] };
        const orders = Array.isArray(body) ? body : body.orders;

        if (!cancelled) {
          setHistoryOrders(Array.isArray(orders) ? orders : []);
          setHistoryState("success");
        }
      } catch (error) {
        if (!cancelled) {
          setHistoryOrders([]);
          setHistoryError(
            error instanceof Error
              ? error.message
              : "We could not load your account orders.",
          );
          setHistoryState("error");
        }
      }
    }

    void loadHistory();

    return () => {
      cancelled = true;
    };
  }, [authLoaded, getToken, isSignedIn]);

  async function handleLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedOrderId = orderId.trim();
    const trimmedEmail = email.trim();
    const trimmedPhone = phone.trim();
    const contactValue = contactMethod === "email" ? trimmedEmail : trimmedPhone;

    if (!trimmedOrderId || !contactValue) {
      setLookupState("error");
      setLookupError("Enter an order ID and matching contact detail.");
      setLookupOrder(null);
      return;
    }

    setLookupState("loading");
    setLookupError("");
    setLookupOrder(null);

    try {
      const response = await fetch(buildApiUrl("/orders/lookup"), {
        body: JSON.stringify({
          orderId: trimmedOrderId,
          ...(contactMethod === "email"
            ? { email: trimmedEmail }
            : { phone: trimmedPhone }),
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const order = (await response.json()) as CustomerOrder;
      setLookupOrder(order);
      setLookupState("success");
    } catch (error) {
      setLookupError(
        error instanceof Error
          ? error.message
          : "We could not find an order matching those details.",
      );
      setLookupState("error");
    }
  }

  return (
    <div className="space-y-8">
      <form
        className="space-y-5 rounded-3xl border border-white/70 bg-white/72 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur sm:p-6"
        onSubmit={handleLookup}
      >
        <SectionTitle>Guest Order Lookup</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <div className="space-y-2">
            <FieldLabel htmlFor="order-id">Order ID</FieldLabel>
            <input
              className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-[#b49872] focus:ring-2 focus:ring-[#b49872]/20"
              id="order-id"
              onChange={(event) => setOrderId(event.target.value)}
              placeholder="KAP-1004"
              type="text"
              value={orderId}
            />
          </div>
          <div className="space-y-2">
            <span className="block text-sm font-semibold text-slate-700">
              Match By
            </span>
            <div className="grid h-12 grid-cols-2 rounded-2xl border border-slate-200 bg-slate-50 p-1">
              {(["email", "phone"] as const).map((method) => (
                <button
                  className={`rounded-xl px-4 text-sm font-semibold capitalize transition ${
                    contactMethod === method
                      ? "bg-white text-[#8f734f] shadow-sm"
                      : "text-slate-500 hover:text-slate-800"
                  }`}
                  key={method}
                  onClick={() => setContactMethod(method)}
                  type="button"
                >
                  {method}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className={contactMethod === "email" ? "space-y-2" : "hidden"}>
            <FieldLabel htmlFor="lookup-email">Email</FieldLabel>
            <input
              className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-[#b49872] focus:ring-2 focus:ring-[#b49872]/20"
              id="lookup-email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              type="email"
              value={email}
            />
          </div>
          <div className={contactMethod === "phone" ? "space-y-2" : "hidden"}>
            <FieldLabel htmlFor="lookup-phone">Phone</FieldLabel>
            <input
              className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-[#b49872] focus:ring-2 focus:ring-[#b49872]/20"
              id="lookup-phone"
              onChange={(event) => setPhone(event.target.value)}
              placeholder="(555) 123-4567"
              type="tel"
              value={phone}
            />
          </div>
        </div>

        <button
          className="inline-flex h-12 w-full items-center justify-center rounded-2xl bg-[#b49872] px-5 text-base font-semibold text-white transition hover:bg-[#a1845f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300 sm:w-auto"
          disabled={lookupState === "loading"}
          type="submit"
        >
          {lookupState === "loading" ? "Looking Up" : "View Order"}
        </button>

        {lookupState === "error" ? (
          <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {lookupError}
          </p>
        ) : null}
      </form>

      {lookupState === "success" && lookupOrder ? (
        <OrderCard order={lookupOrder} />
      ) : lookupState === "idle" ? (
        <EmptyPanel>
          Order details appear here after the order ID and matching contact
          detail are verified.
        </EmptyPanel>
      ) : null}

      <section className="space-y-4">
        <div className="flex flex-col gap-1">
          <SectionTitle>Account Order History</SectionTitle>
          <p className="text-sm leading-6 text-slate-500">
            Signed-in customers can view orders tied to {accountLabel}.
          </p>
        </div>

        <ClerkLoading>
          <OrdersSkeleton />
        </ClerkLoading>
        <ClerkLoaded>
          {!isSignedIn ? (
            <EmptyPanel>Sign in to view orders saved to your account.</EmptyPanel>
          ) : historyState === "loading" ? (
            <OrdersSkeleton />
          ) : historyState === "error" ? (
            <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {historyError}
            </p>
          ) : historyOrders.length > 0 ? (
            <div className="space-y-4">
              {historyOrders.map((order) => (
                <OrderCard key={order.id} order={order} />
              ))}
            </div>
          ) : (
            <EmptyPanel>No account orders are available yet.</EmptyPanel>
          )}
        </ClerkLoaded>
      </section>
    </div>
  );
}
