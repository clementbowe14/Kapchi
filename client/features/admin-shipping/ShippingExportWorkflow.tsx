"use client";

import { useAuth } from "@clerk/nextjs";
import { AlertTriangle, Download, ExternalLink, PackageCheck, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AdminOrderDialog } from "@/features/admin-orders/AdminOrderDialog";
import { AdminOrdersApiError, withAdminToken } from "@/features/admin-orders/api";
import type { AdminOrderSummary } from "@/features/admin-orders/types";
import {
  createShippingExport,
  downloadShippingExport,
  preflightShippingExport,
  triggerCsvDownload,
} from "./api";
import type {
  CreateShippingExportInput,
  PackageMeasurements,
  ShippingExportBatch,
  ShippingExportCandidate,
  ShippingExportWorkflowState,
} from "./types";
import { validatePackage, type PackageErrors, type PackageField } from "./validation";

const emptyPackage: PackageMeasurements = {
  description: "Graduation stole",
  heightInches: "",
  lengthInches: "",
  weightOunces: "",
  widthInches: "",
};

const codeMessages: Record<string, string> = {
  EXPORT_ADDRESS_INCOMPLETE: "A complete U.S. delivery address is required.",
  EXPORT_ALREADY_PREPARED: "This order already belongs to an active shipping export.",
  EXPORT_INTERNATIONAL_UNSUPPORTED: "Version 1 supports U.S. delivery addresses only.",
  EXPORT_REVISION_STALE: "The order changed. Refresh the queue and review it again.",
  EXPORT_SHIPMENT_CONFLICT: "This order has conflicting reusable shipment records and needs manual review.",
};

function messageFor(error: unknown) {
  if (!(error instanceof AdminOrdersApiError)) return "The shipping export could not be completed.";
  if (error.code === "IDEMPOTENCY_CONFLICT") return "This recovery key belongs to different package data. Reopen the workflow and try again.";
  if (error.code && codeMessages[error.code]) return codeMessages[error.code];
  return error.message;
}

function toPayload(candidates: ShippingExportCandidate[], packages: Record<string, PackageMeasurements>): CreateShippingExportInput {
  return {
    orders: candidates.map((candidate) => {
      const value = packages[candidate.orderId];
      return {
        expectedRevision: candidate.revision,
        orderId: candidate.orderId,
        package: {
          ...(value.description.trim() ? { description: value.description.trim() } : {}),
          heightInches: Number(value.heightInches),
          lengthInches: Number(value.lengthInches),
          weightOunces: Number(value.weightOunces),
          widthInches: Number(value.widthInches),
        },
      };
    }),
  };
}

function requestWithTimeout() {
  const controller = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15_000);
  return { controller, finish: () => window.clearTimeout(timer), timedOut: () => timedOut };
}

export function ShippingExportWorkflow({
  onClose,
  onCreated,
  onAuthorizationFailure,
  orders,
}: {
  onClose: () => void;
  onCreated: (batch: ShippingExportBatch) => void;
  onAuthorizationFailure: (error: AdminOrdersApiError) => void;
  orders: AdminOrderSummary[];
}) {
  const { getToken, userId } = useAuth();
  const closeRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const requestVersion = useRef(0);
  const [state, setState] = useState<ShippingExportWorkflowState>("preflighting");
  const [candidates, setCandidates] = useState<ShippingExportCandidate[]>([]);
  const [packages, setPackages] = useState<Record<string, PackageMeasurements>>({});
  const [errors, setErrors] = useState<Record<string, PackageErrors>>({});
  const [error, setError] = useState("");
  const [batch, setBatch] = useState<ShippingExportBatch | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [submittedPayload, setSubmittedPayload] = useState<CreateShippingExportInput | null>(null);
  const [piiApproved, setPiiApproved] = useState(false);
  const orderIds = useMemo(() => orders.map((order) => order.id).sort(), [orders]);
  const fingerprint = `${userId ?? "signed-out"}:${orderIds.join(",")}`;

  useEffect(() => {
    const version = ++requestVersion.current;
    const controller = new AbortController();
    setState("preflighting");
    setError("");
    void withAdminToken(getToken, (token) => preflightShippingExport(token, orderIds, controller.signal))
      .then((result) => {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        setCandidates(result.candidates);
        setPackages(Object.fromEntries(result.candidates.map((candidate) => [
          candidate.orderId,
          candidate.existingPackage ?? { ...emptyPackage },
        ])));
        setState("editing");
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        if (caught instanceof AdminOrdersApiError && (caught.status === 401 || caught.status === 403)) {
          onAuthorizationFailure(caught);
          return;
        }
        setError(messageFor(caught));
        setState("idle");
      });
    return () => {
      requestVersion.current += 1;
      controller.abort();
    };
  }, [fingerprint, getToken, onAuthorizationFailure, orderIds]);

  const ineligible = candidates.filter((candidate) => !candidate.eligible);
  const busy = state === "preflighting" || state === "creating" || state === "recovering" || state === "downloading";
  const lockedForRecovery = state === "creation_unknown";

  function updatePackage(orderId: string, field: PackageField, value: string) {
    if (lockedForRecovery) return;
    setPackages((current) => ({ ...current, [orderId]: { ...current[orderId], [field]: value } }));
    setErrors((current) => ({ ...current, [orderId]: { ...current[orderId], [field]: undefined } }));
    setError("");
    setIdempotencyKey(null);
    setSubmittedPayload(null);
  }

  function validateAll() {
    const next = Object.fromEntries(candidates.map((candidate) => [candidate.orderId, validatePackage(packages[candidate.orderId])]));
    setErrors(next);
    const invalid = Object.values(next).some((row) => Object.keys(row).length > 0);
    if (invalid) {
      setError("Review the highlighted package fields.");
      window.setTimeout(() => errorRef.current?.focus());
    }
    return !invalid;
  }

  async function submit(recover = false) {
    if (busy || ineligible.length) return;
    let payload = submittedPayload;
    let key = idempotencyKey;
    if (!recover) {
      if (!validateAll()) return;
      payload = toPayload(candidates, packages);
      key = crypto.randomUUID();
      setSubmittedPayload(payload);
      setIdempotencyKey(key);
    }
    if (!payload || !key) return;
    const request = requestWithTimeout();
    setState(recover ? "recovering" : "creating");
    setError("");
    try {
      const created = await withAdminToken(getToken, (token) =>
        createShippingExport(token, payload!, key!, request.controller.signal));
      setBatch(created);
      setState("created");
      onCreated(created);
    } catch (caught) {
      if (caught instanceof AdminOrdersApiError && (caught.status === 401 || caught.status === 403)) {
        onAuthorizationFailure(caught);
        return;
      }
      if (request.timedOut() || (caught instanceof AdminOrdersApiError && caught.code === "NETWORK_ERROR")) {
        setState("creation_unknown");
        setError("The request may have completed. Recover with the same protected request key before changing package data.");
      } else if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setState("editing");
        setError(messageFor(caught));
      }
    } finally {
      request.finish();
    }
  }

  async function download() {
    if (!batch || busy) return;
    const controller = new AbortController();
    setState("downloading");
    setError("");
    try {
      const blob = await withAdminToken(getToken, (token) => downloadShippingExport(token, batch, controller.signal));
      triggerCsvDownload(blob, batch.filename);
      setState("downloaded");
    } catch (caught) {
      if (caught instanceof AdminOrdersApiError && (caught.status === 401 || caught.status === 403)) {
        onAuthorizationFailure(caught);
        return;
      }
      setState("download_failed");
      setError(`${messageFor(caught)} Retry downloads this batch only; it will not create another export.`);
    }
  }

  function abandonRecovery() {
    setState("editing");
    setIdempotencyKey(null);
    setSubmittedPayload(null);
    setError("Recovery was abandoned. Verify the Shipping exports page before creating a different batch.");
  }

  return (
    <AdminOrderDialog
      busy={busy}
      description="Validate every selected order, enter one package per order, then create a private Pirate Ship CSV."
      initialFocusRef={closeRef}
      onClose={onClose}
      title="Prepare Pirate Ship export"
    >
      <div className="space-y-5">
        <p className="sr-only" role="status" aria-live="polite">
          {state === "preflighting" ? "Checking selected orders." : state === "editing" ? "Selected orders are ready for review." : state.replaceAll("_", " ")}
        </p>
        {error ? (
          <div ref={errorRef} tabIndex={-1} role="alert" className="border-l-4 border-red-500 bg-red-50 p-3 text-sm text-red-800 focus:outline-none">
            {error}
          </div>
        ) : null}

        {state === "preflighting" ? <p className="py-8 text-center text-sm text-slate-600">Checking export eligibility...</p> : null}

        {candidates.length ? (
          <div className="divide-y divide-slate-200 border-y border-slate-200">
            {candidates.map((candidate) => {
              const row = packages[candidate.orderId] ?? emptyPackage;
              const rowErrors = errors[candidate.orderId] ?? {};
              return (
                <section key={candidate.orderId} aria-labelledby={`package-${candidate.orderId}`} className="py-5 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 id={`package-${candidate.orderId}`} className="font-semibold">{candidate.publicOrderNumber}</h3>
                    <span className={`text-xs font-semibold ${candidate.eligible ? "text-emerald-700" : "text-red-700"}`}>
                      {candidate.eligible ? "Eligible" : "Needs attention"}
                    </span>
                  </div>
                  {!candidate.eligible ? (
                    <ul className="mt-2 space-y-1 text-sm text-red-700">
                      {candidate.codes.map((code) => <li key={code}>{codeMessages[code] ?? "This order cannot be exported yet."}</li>)}
                    </ul>
                  ) : (
                    <div className="mt-4 grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4">
                      <PackageInput order={candidate.publicOrderNumber} field="weightOunces" label="Weight (oz)" value={row.weightOunces} error={rowErrors.weightOunces} disabled={busy || lockedForRecovery} onChange={(value) => updatePackage(candidate.orderId, "weightOunces", value)} />
                      <PackageInput order={candidate.publicOrderNumber} field="lengthInches" label="Length (in)" value={row.lengthInches} error={rowErrors.lengthInches} disabled={busy || lockedForRecovery} onChange={(value) => updatePackage(candidate.orderId, "lengthInches", value)} />
                      <PackageInput order={candidate.publicOrderNumber} field="widthInches" label="Width (in)" value={row.widthInches} error={rowErrors.widthInches} disabled={busy || lockedForRecovery} onChange={(value) => updatePackage(candidate.orderId, "widthInches", value)} />
                      <PackageInput order={candidate.publicOrderNumber} field="heightInches" label="Height (in)" value={row.heightInches} error={rowErrors.heightInches} disabled={busy || lockedForRecovery} onChange={(value) => updatePackage(candidate.orderId, "heightInches", value)} />
                      <label className="col-span-2 grid gap-1 text-sm font-semibold sm:col-span-4">
                        Package description (optional)
                        <input
                          value={row.description}
                          maxLength={120}
                          disabled={busy || lockedForRecovery}
                          aria-invalid={Boolean(rowErrors.description)}
                          aria-describedby={rowErrors.description ? `description-${candidate.orderId}-error` : undefined}
                          onChange={(event) => updatePackage(candidate.orderId, "description", event.target.value)}
                          className="h-11 min-w-0 rounded-md border border-slate-300 px-3 font-normal disabled:bg-slate-100"
                        />
                        {rowErrors.description ? <span id={`description-${candidate.orderId}-error`} className="font-normal text-red-700">{rowErrors.description}</span> : null}
                      </label>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        ) : null}

        {batch ? (
          <section aria-labelledby="created-export" className="space-y-4 border-l-4 border-emerald-500 bg-emerald-50 p-4">
            <div className="flex gap-3">
              <PackageCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" aria-hidden="true" />
              <div className="min-w-0">
                <h3 id="created-export" className="font-semibold text-emerald-950">Export prepared</h3>
                <p className="mt-1 break-all text-sm text-emerald-900">Batch {batch.batchId}</p>
                <p className="mt-1 text-sm text-emerald-900">{batch.rowCount} rows · expires {new Date(batch.expiresAt).toLocaleString()}</p>
              </div>
            </div>
            <button type="button" onClick={() => void download()} disabled={state === "downloading"} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-emerald-700 px-4 text-sm font-semibold text-emerald-950 disabled:opacity-50 sm:w-auto">
              <Download className="h-4 w-4" aria-hidden="true" />
              {state === "downloading" ? "Downloading..." : state === "download_failed" ? "Retry CSV download" : "Download CSV"}
            </button>
            <div className="border-t border-emerald-200 pt-4">
              <label className="flex items-start gap-3 text-sm text-emerald-950">
                <input type="checkbox" checked={piiApproved} onChange={(event) => setPiiApproved(event.target.checked)} className="mt-1 h-4 w-4" />
                <span>This file contains customer contact and delivery data. I will upload this exact batch to Pirate Ship, keep it private, and stop before buying labels.</span>
              </label>
              <a href="https://ship.pirateship.com/ship" target="_blank" rel="noreferrer noopener" aria-disabled={!piiApproved} onClick={(event) => { if (!piiApproved) event.preventDefault(); }} className={`mt-3 inline-flex h-11 items-center gap-2 rounded-md px-4 text-sm font-semibold text-white ${piiApproved ? "bg-slate-950 hover:bg-slate-800" : "cursor-not-allowed bg-slate-400"}`}>
                Open Pirate Ship <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
          </section>
        ) : null}

        {state === "creation_unknown" ? (
          <div className="space-y-3 border border-amber-300 bg-amber-50 p-4">
            <p className="flex gap-2 text-sm text-amber-950"><AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" /> Do not change measurements until recovery finishes.</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button type="button" onClick={() => void submit(true)} className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white"><RotateCcw className="h-4 w-4" aria-hidden="true" /> Recover export</button>
              <button type="button" onClick={abandonRecovery} className="h-11 rounded-md border border-amber-400 px-4 text-sm font-semibold">Abandon recovery and edit</button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end">
          <button ref={closeRef} type="button" disabled={busy} onClick={onClose} className="h-11 rounded-md border border-slate-300 px-4 text-sm font-semibold disabled:opacity-50">Close</button>
          {!batch && state !== "creation_unknown" ? (
            <button type="button" disabled={busy || Boolean(ineligible.length) || !candidates.length} onClick={() => void submit()} className="h-11 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white disabled:opacity-50">
              {state === "creating" ? "Creating export..." : `Create export (${candidates.length})`}
            </button>
          ) : null}
        </div>
      </div>
    </AdminOrderDialog>
  );
}

function PackageInput({
  disabled,
  error,
  field,
  label,
  onChange,
  order,
  value,
}: {
  disabled: boolean;
  error?: string;
  field: Exclude<PackageField, "description">;
  label: string;
  onChange: (value: string) => void;
  order: string;
  value: string;
}) {
  const id = `${field}-${order.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <label htmlFor={id} className="grid min-w-0 gap-1 text-sm font-semibold">
      {label}
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min="0.01"
        max={field === "weightOunces" ? "2400" : "120"}
        step="0.01"
        value={value}
        disabled={disabled}
        aria-label={`${order} ${label}`}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 min-w-0 rounded-md border border-slate-300 px-3 font-normal disabled:bg-slate-100"
      />
      {error ? <span id={`${id}-error`} className="font-normal text-red-700">{error}</span> : null}
    </label>
  );
}
