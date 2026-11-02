"use client";

import { useAuth } from "@clerk/nextjs";
import { ArrowLeft, Mail, Phone, RefreshCw, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  AdminOrdersApiError,
  adminOrdersErrorMessage,
  fetchAdminOrder,
  withAdminToken,
} from "./api";
import {
  customizationImageStatus,
  customizationLevel,
  formatAddress,
  formatAdminDate,
  formatAdminMoney,
  formatProductionEstimate,
  formatProductionSelection,
  snapshotLabel,
  statusLabel,
} from "./format";
import type { AdminOrderDetail, AdminOrderItem } from "./types";
import {
  AdminOrdersShell,
  LoadingPanel,
  StatePanel,
  StatusBadge,
} from "./AdminOrdersUi";

type DetailState = { identity: string; order: AdminOrderDetail } | null;

export function AdminOrderDetailClient({
  orderId,
  returnHref,
}: {
  orderId: string;
  returnHref: string;
}) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const identity = isLoaded && isSignedIn && userId ? userId : null;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [data, setData] = useState<DetailState>(null);
  const [error, setError] = useState<AdminOrdersApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const sequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const visibleOrder = data?.identity === identity ? data.order : null;

  const load = useCallback(async () => {
    if (!identity) return;
    const requestIdentity = identity;
    const requestSequence = ++sequence.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setError(null);
    setLoading(true);
    try {
      const order = await withAdminToken(getToken, (token) =>
        fetchAdminOrder(token, orderId, controller.signal));
      if (
        controller.signal.aborted ||
        requestSequence !== sequence.current ||
        identityRef.current !== requestIdentity
      ) return;
      setData({ identity: requestIdentity, order });
    } catch (caught) {
      if (controller.signal.aborted) return;
      const nextError = caught instanceof AdminOrdersApiError
        ? caught
        : new AdminOrdersApiError("The admin order could not be loaded.", 0);
      if (nextError.status === 401 || nextError.status === 403) setData(null);
      setError(nextError);
    } finally {
      if (requestSequence === sequence.current) setLoading(false);
    }
  }, [getToken, identity, orderId]);

  useEffect(() => {
    sequence.current += 1;
    activeRequest.current?.abort();
    setError(null);
    if (!identity) {
      setData(null);
      setLoading(false);
      return;
    }
    void load();
    return () => {
      sequence.current += 1;
      activeRequest.current?.abort();
    };
  }, [identity, load, retryVersion]);

  return (
    <AdminOrdersShell
      title={visibleOrder?.publicOrderNumber ?? "Order detail"}
      description="Review the stored customer, item, fabric, and customization details for this order."
    >
      <Link
        href={returnHref}
        className="mb-5 inline-flex h-10 items-center gap-2 rounded-md px-2 text-sm font-semibold text-slate-700 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872]"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to ongoing orders
      </Link>

      {!isLoaded ? <LoadingPanel label="Checking admin session" variant="detail" /> : !identity ? (
        <StatePanel
          actionHref="/sign-in"
          actionLabel="Sign in"
          title="Admin sign-in required"
          message="Sign in with an authorized store administrator account to view this order."
        />
      ) : loading && !visibleOrder ? <LoadingPanel label="Loading order detail" variant="detail" /> : error && !visibleOrder ? (
        error.status === 403 ? (
          <StatePanel role="alert" title="Admin access required" message="This account does not have permission to view store orders." />
        ) : error.status === 404 || error.status === 400 ? (
          <StatePanel role="alert" actionHref={returnHref} actionLabel="Return to orders" title="Order not found" message="This order is unavailable or its identifier is invalid." />
        ) : error.status === 401 ? (
          <StatePanel role="alert" actionHref="/sign-in" actionLabel="Sign in again" title="Session expired" message="Your admin session could not be refreshed. Sign in again to continue." />
        ) : (
          <StatePanel role="alert" title="Order unavailable" message={adminOrdersErrorMessage(error)} onRetry={() => setRetryVersion((value) => value + 1)} />
        )
      ) : visibleOrder ? (
        <OrderDetail order={visibleOrder} loading={loading} error={error} onRetry={() => setRetryVersion((value) => value + 1)} />
      ) : null}
    </AdminOrdersShell>
  );
}

function OrderDetail({
  error,
  loading,
  onRetry,
  order,
}: {
  error: AdminOrdersApiError | null;
  loading: boolean;
  onRetry: () => void;
  order: AdminOrderDetail;
}) {
  const address = formatAddress(order.shipping.address);
  return (
    <div className="space-y-7">
      {loading ? <p role="status" className="text-sm text-slate-600">Refreshing order...</p> : null}
      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="alert">
          <p>Showing last-known order data. {adminOrdersErrorMessage(error)}</p>
          <button type="button" onClick={onRetry} className="inline-flex h-9 items-center gap-2 rounded-md border border-amber-300 px-3 font-semibold">
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Retry
          </button>
        </div>
      ) : null}

      <section aria-labelledby="order-summary-heading" className="border-y border-slate-200 bg-white px-4 py-5 sm:px-5">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h2 id="order-summary-heading" className="text-base font-semibold">Order summary</h2>
            <p className="mt-1 text-sm text-slate-600">Placed {formatAdminDate(order.createdAt)}</p>
            <p className="mt-3 text-2xl font-semibold">{formatAdminMoney(order.total)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusBadge context="Order status" value={order.status} />
            <StatusBadge context="Payment status" value={order.paymentStatus} />
            <StatusBadge context="Fulfillment status" value={order.fulfillmentStatus} />
          </div>
        </div>
      </section>

      <section aria-labelledby="customer-heading">
        <h2 id="customer-heading" className="mb-3 text-lg font-semibold">Customer and delivery</h2>
        <div className="grid border-y border-slate-200 bg-white md:grid-cols-2 md:divide-x md:divide-slate-200">
          <dl className="grid gap-4 p-5 text-sm">
            <ContactRow icon={<UserRound />} label="Name" value={order.contactSnapshot.name ?? "Not provided"} />
            <ContactRow icon={<Mail />} label="Email" value={order.contactSnapshot.email ?? "Not provided"} />
            <ContactRow icon={<Phone />} label="Phone" value={order.contactSnapshot.phone ?? "Not provided"} />
            <div>
              <dt className="text-xs font-semibold uppercase text-slate-500">Preferred contact</dt>
              <dd className="mt-1">{order.contactSnapshot.preferredContactMethod ? statusLabel(order.contactSnapshot.preferredContactMethod) : "Not provided"}</dd>
            </div>
          </dl>
          <div className="border-t border-slate-200 p-5 md:border-t-0">
            <h3 className="text-sm font-semibold">Shipping address</h3>
            <address className="mt-3 not-italic text-sm leading-6 text-slate-600">
              <p>{order.shipping.name ?? "Not provided"}</p>
              {address.length ? address.map((line) => <p key={line}>{line}</p>) : <p>Not provided</p>}
            </address>
          </div>
        </div>
      </section>

      <section aria-labelledby="items-heading">
        <div className="mb-3 flex items-end justify-between gap-3">
          <h2 id="items-heading" className="text-lg font-semibold">Purchased items</h2>
          <p className="text-sm text-slate-600">{order.totalQuantity} total units</p>
        </div>
        <div className="space-y-3">
          {order.items.map((item, index) => (
            <OrderItemDetail key={item.id} item={item} index={index} />
          ))}
        </div>
      </section>
    </div>
  );
}

function ContactRow({ icon, label, value }: { icon: ReactElement; label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 text-slate-400" aria-hidden="true">{icon}</span>
      <div className="min-w-0">
        <dt className="text-xs font-semibold uppercase text-slate-500">{label}</dt>
        <dd className="mt-1 break-words">{value}</dd>
      </div>
    </div>
  );
}

function OrderItemDetail({ item, index }: { item: AdminOrderItem; index: number }) {
  const listing = snapshotLabel(item.snapshots.listing, ["title", "name", "label"]) ?? "Kapchi item";
  const fabric = snapshotLabel(item.snapshots.fabric, ["name", "label", "color"]) ?? "Not stored";
  const text = item.production.availability.text === "present"
    ? [item.production.text.line1, item.production.text.line2].filter(Boolean).join(" / ") || "Stored selection"
    : item.production.availability.text === "not_selected" ? "Not selected" : "Not stored";
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
      <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase text-[#8f734f]">Item {index + 1}</p>
          <h3 className="mt-1 text-base font-semibold">{listing}</h3>
          <p className="mt-1 text-sm text-slate-600">Fabric: {fabric}</p>
        </div>
        <div className="text-sm sm:text-right">
          <p>{item.quantity} x {formatAdminMoney(item.unitPrice)}</p>
          <p className="mt-1 font-semibold">{formatAdminMoney(item.total)}</p>
        </div>
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Selection label="Customization level" value={customizationLevel(item.snapshots.customization)} />
        <Selection label="Text" value={text} />
        <Selection label="Image" value={customizationImageStatus(item)} />
        <Selection label="Font" value={formatProductionSelection("font", item.production.font, item.production.availability.font)} />
        <Selection label="Placement" value={formatProductionSelection("placement", item.production.placement, item.production.availability.placement)} />
        <Selection label="Trim" value={formatProductionSelection("trim", item.production.trim, item.production.availability.trim)} />
        <Selection label="Production priority" value={item.production.priorityCode ? statusLabel(item.production.priorityCode) : "Not stored"} />
        <Selection label="Production estimate" value={formatProductionEstimate(item.production.estimateSnapshot)} />
      </dl>
      <div className="mt-4 border-t border-slate-200 pt-4 text-sm">
        <p className="text-xs font-semibold uppercase text-slate-500">Production notes</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-slate-900">{item.productionNotes ?? "Not stored"}</p>
      </div>
      {item.catalogReference.listingStatus === "archived" || item.catalogReference.fabricStatus === "archived" ? (
        <p className="mt-4 border-l-2 border-amber-400 pl-3 text-xs text-slate-600">This item references an archived catalog selection. Stored order details are shown.</p>
      ) : null}
    </article>
  );
}

function Selection({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs font-semibold uppercase text-slate-500">{label}</dt><dd className="mt-1 break-words text-slate-900">{value}</dd></div>;
}
