"use client";

import { useAuth } from "@clerk/nextjs";
import { ChevronRight, Filter, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AdminOrdersApiError,
  adminOrdersErrorMessage,
  fetchAdminOrders,
  withAdminToken,
} from "./api";
import { formatAdminDate, formatAdminMoney, statusLabel } from "./format";
import {
  type AdminOrderFilters,
  type AdminOrderSearchPage,
  isOngoingOrderStatus,
  isOrderSort,
  ongoingOrderStatuses,
} from "./types";
import {
  AdminOrdersShell,
  LoadingPanel,
  StatePanel,
  StatusBadge,
} from "./AdminOrdersUi";

type DataState = {
  filterFingerprint: string;
  filters: AdminOrderFilters;
  identity: string;
  page: AdminOrderSearchPage;
} | null;

function queryFor(filters: AdminOrderFilters) {
  const query = new URLSearchParams();
  if (filters.orderStatus) query.set("status", filters.orderStatus);
  if (filters.sort !== "created_desc") query.set("sort", filters.sort);
  return query.toString();
}

function detailHref(orderId: string, filters: AdminOrderFilters) {
  const query = queryFor(filters);
  return `/admin/orders/${encodeURIComponent(orderId)}${query ? `?${query}` : ""}`;
}

function mergeOrders(current: AdminOrderSearchPage, incoming: AdminOrderSearchPage) {
  const rows = new Map(current.orders.map((order) => [order.id, order]));
  for (const order of incoming.orders) rows.set(order.id, order);
  return { nextCursor: incoming.nextCursor, orders: [...rows.values()] };
}

function customerName(order: AdminOrderSearchPage["orders"][number]) {
  return order.customer.name || order.customer.email || "Guest customer";
}

export function AdminOrdersDashboard({
  initialSort,
  initialStatus,
}: {
  initialSort?: string;
  initialStatus?: string;
}) {
  const router = useRouter();
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const initialFilters = useMemo<AdminOrderFilters>(() => ({
    orderStatus: isOngoingOrderStatus(initialStatus) ? initialStatus : undefined,
    sort: isOrderSort(initialSort) ? initialSort : "created_desc",
  }), [initialSort, initialStatus]);
  const [draftStatus, setDraftStatus] = useState(initialFilters.orderStatus ?? "");
  const [draftSort, setDraftSort] = useState(initialFilters.sort);
  const [filters, setFilters] = useState(initialFilters);
  const [data, setData] = useState<DataState>(null);
  const [appendError, setAppendError] = useState<AdminOrdersApiError | null>(null);
  const [error, setError] = useState<AdminOrdersApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [retryVersion, setRetryVersion] = useState(0);
  const sequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const identity = isLoaded && isSignedIn && userId ? userId : null;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const filterFingerprint = queryFor(filters);
  const visiblePage = data?.identity === identity ? data.page : null;
  const visibleFilters = data?.identity === identity ? data.filters : filters;
  const visiblePageMatchesFilters = data?.filterFingerprint === filterFingerprint;

  const requestPage = useCallback(async (
    mode: "replace" | "append",
    cursor?: string,
  ) => {
    if (!identity) return;
    const requestIdentity = identity;
    const requestFilters = { ...filters };
    const requestFingerprint = queryFor(requestFilters);
    const requestSequence = ++sequence.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    if (mode === "append") {
      setAppendError(null);
      setLoadingMore(true);
    } else {
      setAppendError(null);
      setError(null);
      setLoading(true);
    }
    try {
      const page = await withAdminToken(getToken, (token) =>
        fetchAdminOrders(token, requestFilters, controller.signal, cursor));
      if (
        controller.signal.aborted ||
        requestSequence !== sequence.current ||
        identityRef.current !== requestIdentity
      ) return;
      setData((current) => ({
        filterFingerprint: requestFingerprint,
        filters: requestFilters,
        identity: requestIdentity,
        page: mode === "append"
          && current?.identity === requestIdentity
          && current.filterFingerprint === requestFingerprint
          ? mergeOrders(current.page, page)
          : page,
      }));
      setAnnouncement(mode === "append"
        ? `${page.orders.length} more orders loaded.`
        : `${page.orders.length} orders shown.`);
    } catch (caught) {
      if (controller.signal.aborted) return;
      const nextError = caught instanceof AdminOrdersApiError
        ? caught
        : new AdminOrdersApiError("Admin orders could not be loaded.", 0);
      if (nextError.status === 401 || nextError.status === 403) {
        setData(null);
        setAppendError(null);
        setError(nextError);
      } else if (mode === "append") {
        setAppendError(nextError);
      } else {
        setError(nextError);
      }
    } finally {
      if (requestSequence === sequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [filters, getToken, identity]);

  useEffect(() => {
    sequence.current += 1;
    activeRequest.current?.abort();
    setAppendError(null);
    setError(null);
    setAnnouncement("");
    if (!identity) {
      setData(null);
      setLoading(false);
      return;
    }
    void requestPage("replace");
    return () => {
      sequence.current += 1;
      activeRequest.current?.abort();
    };
  }, [identity, filters, requestPage, retryVersion]);

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    const next: AdminOrderFilters = {
      orderStatus: isOngoingOrderStatus(draftStatus) ? draftStatus : undefined,
      sort: isOrderSort(draftSort) ? draftSort : "created_desc",
    };
    setFilters(next);
    const query = queryFor(next);
    router.replace(`/admin/orders${query ? `?${query}` : ""}`, { scroll: false });
  }

  function clearFilters() {
    const next: AdminOrderFilters = { sort: "created_desc" };
    setDraftStatus("");
    setDraftSort("created_desc");
    setFilters(next);
    router.replace("/admin/orders", { scroll: false });
  }

  const filtered = Boolean(filters.orderStatus || filters.sort !== "created_desc");

  return (
    <AdminOrdersShell
      title="Ongoing orders"
      description="Review active customer orders, production selections, and fulfillment status."
    >
      {!isLoaded ? <LoadingPanel label="Checking admin session" /> : !identity ? (
        <StatePanel
          actionHref="/sign-in"
          actionLabel="Sign in"
          title="Admin sign-in required"
          message="Sign in with an authorized store administrator account to view ongoing orders."
        />
      ) : (
        <div className="space-y-5">
          <form
            onSubmit={applyFilters}
            className="flex flex-col gap-4 border-y border-slate-200 bg-white px-4 py-4 lg:flex-row lg:items-end"
          >
            <div className="grid flex-1 gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-semibold text-slate-700">
                Order status
                <select
                  value={draftStatus}
                  onChange={(event) => setDraftStatus(event.target.value)}
                  className="h-11 rounded-md border border-slate-300 bg-white px-3 font-normal text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872]"
                >
                  <option value="">All ongoing statuses</option>
                  {ongoingOrderStatuses.map((status) => (
                    <option key={status} value={status}>{statusLabel(status)}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-semibold text-slate-700">
                Date order
                <select
                  value={draftSort}
                  onChange={(event) => setDraftSort(event.target.value as AdminOrderFilters["sort"])}
                  className="h-11 rounded-md border border-slate-300 bg-white px-3 font-normal text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872]"
                >
                  <option value="created_desc">Newest first</option>
                  <option value="created_asc">Oldest first</option>
                </select>
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={loading}
                className="inline-flex h-11 items-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2"
              >
                <Filter className="h-4 w-4" aria-hidden="true" />
                Apply filters
              </button>
              <button
                type="button"
                onClick={clearFilters}
                disabled={loading || !filtered}
                className="h-11 rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872]"
              >
                Clear
              </button>
            </div>
          </form>

          <p className="sr-only" role="status">{announcement}</p>
          {loading && !visiblePage ? <LoadingPanel label="Loading ongoing orders" /> : null}
          {error && !visiblePage ? error.status === 403 ? (
            <StatePanel
              role="alert"
              title="Admin access required"
              message="This account does not have permission to view store orders."
            />
          ) : error.status === 401 ? (
            <StatePanel
              role="alert"
              actionHref="/sign-in"
              actionLabel="Sign in again"
              title="Session expired"
              message="Your admin session could not be refreshed. Sign in again to continue."
            />
          ) : (
            <StatePanel
              role="alert"
              title="Orders unavailable"
              message={adminOrdersErrorMessage(error)}
              onRetry={() => setRetryVersion((value) => value + 1)}
            />
          ) : null}

          {visiblePage ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
                <p>{visiblePage.orders.length} {visiblePage.orders.length === 1 ? "order" : "orders"} shown</p>
                {loading ? <p role="status">Refreshing orders...</p> : null}
              </div>
              {error ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="alert">
                  <p>Showing last-known results. {adminOrdersErrorMessage(error)}</p>
                  <button type="button" onClick={() => setRetryVersion((value) => value + 1)} className="inline-flex h-9 items-center gap-2 rounded-md border border-amber-300 px-3 font-semibold">
                    <RefreshCw className="h-4 w-4" aria-hidden="true" /> Retry
                  </button>
                </div>
              ) : null}
              {visiblePage.orders.length === 0 ? (
                <StatePanel
                  buttonLabel="Clear filters"
                  title={filtered ? "No orders match these filters" : "No ongoing orders"}
                  message={filtered
                    ? "Clear the filters or choose another ongoing status."
                    : "New paid and in-progress orders will appear here."}
                  onRetry={filtered ? clearFilters : undefined}
                />
              ) : (
                <OrdersRows page={visiblePage} filters={visibleFilters} />
              )}
              {visiblePage.nextCursor && visiblePageMatchesFilters ? (
                <div className="flex justify-center pt-2">
                  <div className="text-center">
                    {appendError ? (
                      <p className="mb-2 text-sm text-red-700" role="alert">
                        More orders could not be loaded. Existing rows are unchanged. {adminOrdersErrorMessage(appendError)}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      disabled={loading || loadingMore}
                      onClick={() => void requestPage("append", visiblePage.nextCursor ?? undefined)}
                      className="inline-flex h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872]"
                    >
                      {loadingMore ? "Loading..." : appendError ? "Retry loading more" : "Load more orders"}
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </AdminOrdersShell>
  );
}

function OrdersRows({ page, filters }: { page: AdminOrderSearchPage; filters: AdminOrderFilters }) {
  return (
    <div className="border-y border-slate-200 bg-white">
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Ongoing customer orders</caption>
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              {['Order', 'Customer', 'Placed', 'Items', 'Total', 'Order status', 'Payment', 'Fulfillment', ''].map((label) => (
                <th key={label || 'action'} scope="col" className="px-3 py-3 font-semibold">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {page.orders.map((order) => (
              <tr key={order.id} className="align-top hover:bg-slate-50/70">
                <td className="px-3 py-4 font-semibold text-slate-950">{order.publicOrderNumber}</td>
                <td className="max-w-56 px-3 py-4">
                  <p className="font-medium text-slate-900">{customerName(order)}</p>
                  {order.customer.email && order.customer.name ? <p className="break-all text-xs text-slate-500">{order.customer.email}</p> : null}
                  {order.customer.phone ? <p className="text-xs text-slate-500">{order.customer.phone}</p> : null}
                </td>
                <td className="whitespace-nowrap px-3 py-4 text-slate-600">{formatAdminDate(order.createdAt)}</td>
                <td className="px-3 py-4 text-slate-600">{order.itemCount} lines<br />{order.totalQuantity} units</td>
                <td className="whitespace-nowrap px-3 py-4 font-semibold">{formatAdminMoney(order.total)}</td>
                <td className="px-3 py-4"><StatusBadge value={order.status} /></td>
                <td className="px-3 py-4"><StatusBadge value={order.paymentStatus} /></td>
                <td className="px-3 py-4"><StatusBadge value={order.fulfillmentStatus} /></td>
                <td className="px-3 py-4 text-right">
                  <Link href={detailHref(order.id, filters)} title={`View ${order.publicOrderNumber}`} aria-label={`View ${order.publicOrderNumber}`} className="inline-flex h-10 w-10 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872]">
                    <ChevronRight className="h-5 w-5" aria-hidden="true" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="divide-y divide-slate-200 lg:hidden">
        {page.orders.map((order) => (
          <article key={order.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{order.publicOrderNumber}</p>
                <p className="mt-1 break-words text-sm text-slate-600">{customerName(order)}</p>
                {order.customer.email && order.customer.name ? <p className="mt-1 break-all text-xs text-slate-500">{order.customer.email}</p> : null}
                {order.customer.phone ? <p className="mt-1 text-xs text-slate-500">{order.customer.phone}</p> : null}
              </div>
              <StatusBadge value={order.status} />
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div><dt className="text-xs text-slate-500">Placed</dt><dd>{formatAdminDate(order.createdAt)}</dd></div>
              <div><dt className="text-xs text-slate-500">Total</dt><dd className="font-semibold">{formatAdminMoney(order.total)}</dd></div>
              <div><dt className="text-xs text-slate-500">Lines</dt><dd>{order.itemCount}</dd></div>
              <div><dt className="text-xs text-slate-500">Units</dt><dd>{order.totalQuantity}</dd></div>
              <div><dt className="text-xs text-slate-500">Payment</dt><dd>{statusLabel(order.paymentStatus)}</dd></div>
              <div><dt className="text-xs text-slate-500">Fulfillment</dt><dd>{statusLabel(order.fulfillmentStatus)}</dd></div>
            </dl>
            <Link href={detailHref(order.id, filters)} className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-slate-300 text-sm font-semibold text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872]">
              View order <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </article>
        ))}
      </div>
    </div>
  );
}
