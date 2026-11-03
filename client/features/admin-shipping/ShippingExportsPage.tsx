"use client";

import { useAuth } from "@clerk/nextjs";
import { Download, ExternalLink, RefreshCw, ShieldAlert, Truck } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdminOrderDialog } from "@/features/admin-orders/AdminOrderDialog";
import { AdminOrdersApiError, withAdminToken } from "@/features/admin-orders/api";
import { AdminOrdersShell, LoadingPanel, StatePanel, StatusBadge } from "@/features/admin-orders/AdminOrdersUi";
import {
  cancelShippingExport,
  downloadShippingExport,
  getShippingExport,
  listShippingExports,
  releaseShippingExport,
  triggerCsvDownload,
} from "./api";
import type { ShippingExportBatch, ShippingExportBatchPage } from "./types";

type Resolution = { batch: ShippingExportBatch; command: "cancel" | "release" } | null;

function errorText(caught: unknown) {
  return caught instanceof AdminOrdersApiError ? caught.message : "Shipping exports could not be loaded.";
}

export function ShippingExportsPage() {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const identity = isLoaded && isSignedIn && userId ? userId : null;
  const requestVersion = useRef(0);
  const [page, setPage] = useState<ShippingExportBatchPage | null>(null);
  const [active, setActive] = useState<ShippingExportBatch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [authorizationError, setAuthorizationError] = useState<AdminOrdersApiError | null>(null);
  const [status, setStatus] = useState("");
  const [resolution, setResolution] = useState<Resolution>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [piiApproved, setPiiApproved] = useState(false);

  const handleAuthorizationFailure = useCallback((caught: AdminOrdersApiError) => {
    setPage(null);
    setActive(null);
    setResolution(null);
    setAuthorizationError(caught);
  }, []);

  const load = useCallback(async () => {
    if (!identity) return;
    const version = ++requestVersion.current;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setAuthorizationError(null);
    try {
      const result = await withAdminToken(getToken, (token) => listShippingExports(token, controller.signal));
      if (version !== requestVersion.current) return;
      setPage(result);
      setActive((current) => result.batches.find((batch) => batch.batchId === current?.batchId) ?? null);
    } catch (caught) {
      if (!controller.signal.aborted && version === requestVersion.current) {
        if (caught instanceof AdminOrdersApiError && (caught.status === 401 || caught.status === 403)) {
          handleAuthorizationFailure(caught);
        } else setError(errorText(caught));
      }
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
    return () => controller.abort();
  }, [getToken, handleAuthorizationFailure, identity]);

  useEffect(() => {
    if (!identity) {
      requestVersion.current += 1;
      setPage(null);
      setActive(null);
      setError("");
      setAuthorizationError(null);
      return;
    }
    void load();
    return () => { requestVersion.current += 1; };
  }, [identity, load]);

  async function openBatch(batch: ShippingExportBatch) {
    const controller = new AbortController();
    setError("");
    try {
      const detail = await withAdminToken(getToken, (token) => getShippingExport(token, batch.batchId, controller.signal));
      setActive(detail);
      setPiiApproved(false);
    } catch (caught) {
      if (caught instanceof AdminOrdersApiError && (caught.status === 401 || caught.status === 403)) handleAuthorizationFailure(caught);
      else setError(errorText(caught));
    }
  }

  async function download(batch: ShippingExportBatch) {
    const controller = new AbortController();
    setDownloadBusy(true);
    setError("");
    try {
      const blob = await withAdminToken(getToken, (token) => downloadShippingExport(token, batch, controller.signal));
      triggerCsvDownload(blob, batch.filename);
      setStatus(`${batch.filename} download started.`);
    } catch (caught) {
      if (caught instanceof AdminOrdersApiError && (caught.status === 401 || caught.status === 403)) handleAuthorizationFailure(caught);
      else setError(`${errorText(caught)} Retry will request this batch only.`);
    } finally {
      setDownloadBusy(false);
    }
  }

  function replaceBatch(next: ShippingExportBatch) {
    setPage((current) => current ? {
      ...current,
      batches: current.batches.map((batch) => batch.batchId === next.batchId ? next : batch),
    } : current);
    setActive(next);
    setResolution(null);
    setStatus(next.status === "cancelled" ? "Export cancelled." : "Expired export released.");
  }

  return (
    <AdminOrdersShell
      eyebrow="Shipping operations"
      title="Shipping exports"
      description="Recover Pirate Ship batches, retry private downloads, and resolve exports without relying on browser history."
    >
      <div className="mb-5 flex flex-wrap gap-2">
        <Link href="/admin/orders?status=ready_to_ship" className="inline-flex h-10 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50">Ready-to-ship orders</Link>
        <button type="button" onClick={() => void load()} disabled={loading || !identity} className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 disabled:opacity-50"><RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh</button>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{status}</p>
      {!isLoaded ? <LoadingPanel label="Checking admin session" /> : !identity ? (
        <StatePanel actionHref="/sign-in" actionLabel="Sign in" title="Admin sign-in required" message="Sign in with an authorized store administrator account to manage shipping exports." />
      ) : authorizationError?.status === 401 ? (
        <StatePanel role="alert" actionHref="/sign-in" actionLabel="Sign in again" title="Session expired" message="Your admin session could not be refreshed. Sign in again to continue." />
      ) : authorizationError?.status === 403 ? (
        <StatePanel role="alert" title="Shipping access required" message="This account does not have permission to manage shipping exports." />
      ) : loading && !page ? <LoadingPanel label="Loading shipping exports" /> : error && !page ? (
        <StatePanel role="alert" title="Shipping exports unavailable" message={error} onRetry={() => void load()} />
      ) : page ? (
        <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(0,1.2fr)]">
          <section aria-labelledby="export-list-heading" className="min-w-0 border-y border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-4">
              <h2 id="export-list-heading" className="font-semibold">Prepared and unresolved exports</h2>
              <p className="mt-1 text-sm text-slate-600">{page.batches.length} batches</p>
            </div>
            {page.batches.length ? (
              <div className="divide-y divide-slate-200">
                {page.batches.map((batch) => (
                  <button key={batch.batchId} type="button" onClick={() => void openBatch(batch)} className={`block w-full px-4 py-4 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#b49872] ${active?.batchId === batch.batchId ? "bg-slate-50" : ""}`}>
                    <span className="flex items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">{batch.filename}</span>
                        <span className="mt-1 block break-all text-xs text-slate-500">{batch.batchId}</span>
                        <span className="mt-2 block text-xs text-slate-600">{batch.rowCount} rows · expires {new Date(batch.expiresAt).toLocaleDateString()}</span>
                      </span>
                      <StatusBadge value={batch.status} />
                    </span>
                  </button>
                ))}
              </div>
            ) : <p className="px-4 py-10 text-center text-sm text-slate-600">No prepared or unresolved expired exports.</p>}
          </section>

          <section aria-labelledby="export-detail-heading" className="min-w-0 border-y border-slate-200 bg-white px-4 py-5 sm:px-5">
            {error ? <p className="mb-4 border-l-4 border-red-500 bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
            {!active ? (
              <div className="py-10 text-center text-sm text-slate-600">Select an export to review its recovery actions.</div>
            ) : (
              <div className="space-y-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h2 id="export-detail-heading" className="break-words text-lg font-semibold">{active.filename}</h2>
                    <p className="mt-1 break-all text-xs text-slate-500">Batch {active.batchId}</p>
                    <p className="mt-2 text-sm text-slate-600">Mapping v{active.mappingVersion} · {active.rowCount} rows · expires {new Date(active.expiresAt).toLocaleString()}</p>
                  </div>
                  <StatusBadge value={active.status} />
                </div>

                <div className="flex flex-col gap-2 border-y border-slate-200 py-4 sm:flex-row sm:flex-wrap">
                  {active.allowedActions.includes("download") ? (
                    <button type="button" disabled={downloadBusy} onClick={() => void download(active)} className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white disabled:opacity-50"><Download className="h-4 w-4" aria-hidden="true" /> {downloadBusy ? "Downloading..." : "Download CSV"}</button>
                  ) : null}
                  {active.allowedActions.includes("cancel") ? <button type="button" onClick={() => setResolution({ batch: active, command: "cancel" })} className="h-11 rounded-md border border-red-300 px-4 text-sm font-semibold text-red-700">Cancel export</button> : null}
                  {active.allowedActions.includes("release") ? <button type="button" onClick={() => setResolution({ batch: active, command: "release" })} className="h-11 rounded-md border border-amber-400 px-4 text-sm font-semibold text-amber-900">Release expired export</button> : null}
                </div>

                <div>
                  <h3 className="text-sm font-semibold">Orders and exact shipments</h3>
                  <div className="mt-2 divide-y divide-slate-200">
                    {active.items.map((item) => (
                      <div key={item.shipmentId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0"><p className="font-semibold">{item.publicOrderNumber}</p><p className="break-all text-xs text-slate-500">Shipment {item.shipmentId}</p></div>
                        {active.allowedActions.includes("confirm_shipment") ? (
                          <Link href={`/admin/orders/${encodeURIComponent(item.orderId)}?shipmentId=${encodeURIComponent(item.shipmentId)}`} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-300 px-3 text-sm font-semibold"><Truck className="h-4 w-4" aria-hidden="true" /> Enter tracking</Link>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>

                {active.status === "prepared" ? (
                  <div className="border-l-4 border-amber-400 bg-amber-50 p-4">
                    <p className="flex gap-2 text-sm font-semibold text-amber-950"><ShieldAlert className="h-5 w-5 shrink-0" aria-hidden="true" /> Customer data disclosure</p>
                    <label className="mt-3 flex items-start gap-3 text-sm text-amber-950"><input type="checkbox" className="mt-1 h-4 w-4" checked={piiApproved} onChange={(event) => setPiiApproved(event.target.checked)} /><span>I will upload this exact CSV directly, keep customer data private, and stop before purchasing labels for human approval.</span></label>
                    <a href="https://ship.pirateship.com/ship" target="_blank" rel="noreferrer noopener" aria-disabled={!piiApproved} onClick={(event) => { if (!piiApproved) event.preventDefault(); }} className={`mt-3 inline-flex h-11 items-center gap-2 rounded-md px-4 text-sm font-semibold text-white ${piiApproved ? "bg-slate-950" : "cursor-not-allowed bg-slate-400"}`}>Open Pirate Ship <ExternalLink className="h-4 w-4" aria-hidden="true" /></a>
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </div>
      ) : null}
      {resolution ? <ResolveExportDialog resolution={resolution} onAuthorizationFailure={handleAuthorizationFailure} onClose={() => setResolution(null)} onResolved={replaceBatch} /> : null}
    </AdminOrdersShell>
  );
}

function ResolveExportDialog({
  onClose,
  onAuthorizationFailure,
  onResolved,
  resolution,
}: {
  onClose: () => void;
  onAuthorizationFailure: (error: AdminOrdersApiError) => void;
  onResolved: (batch: ShippingExportBatch) => void;
  resolution: NonNullable<Resolution>;
}) {
  const { getToken } = useAuth();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState("");
  const [certified, setCertified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const verb = resolution.command === "cancel" ? "Cancel" : "Release";

  async function submit() {
    const normalizedReason = reason.trim();
    if (!certified || normalizedReason.length < 3 || normalizedReason.length > 500) {
      setError("Certify that no label was purchased and enter a reason from 3 to 500 characters.");
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    setError("");
    try {
      const command = resolution.command === "cancel" ? cancelShippingExport : releaseShippingExport;
      const result = await withAdminToken(getToken, (token) => command(token, resolution.batch.batchId, normalizedReason, key, controller.signal));
      onResolved({
        ...resolution.batch,
        allowedActions: [],
        batchId: result.batchId,
        status: result.status,
      });
    } catch (caught) {
      if (caught instanceof AdminOrdersApiError && (caught.status === 401 || caught.status === 403)) onAuthorizationFailure(caught);
      else setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminOrderDialog busy={busy} initialFocusRef={cancelRef} onClose={onClose} title={`${verb} shipping export`} description="Kapchi cannot see whether Pirate Ship purchased a label. This certification is required before releasing the order for another export.">
      <div className="space-y-4">
        <label className="grid gap-1.5 text-sm font-semibold">Reason<input value={reason} disabled={busy} onChange={(event) => { setReason(event.target.value); setKey(crypto.randomUUID()); setError(""); }} className="h-11 rounded-md border border-slate-300 px-3 font-normal" /></label>
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={certified} disabled={busy} onChange={(event) => { setCertified(event.target.checked); setKey(crypto.randomUUID()); setError(""); }} className="mt-1 h-4 w-4" /><span>I certify that no label was purchased for batch {resolution.batch.batchId}. I will delete local CSV copies and remove any matching Pirate Ship draft.</span></label>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
        <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end"><button ref={cancelRef} type="button" disabled={busy} onClick={onClose} className="h-11 rounded-md border border-slate-300 px-4 text-sm font-semibold">Keep export</button><button type="button" disabled={busy} onClick={() => void submit()} className="h-11 rounded-md bg-red-700 px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Submitting..." : verb}</button></div>
      </div>
    </AdminOrderDialog>
  );
}
