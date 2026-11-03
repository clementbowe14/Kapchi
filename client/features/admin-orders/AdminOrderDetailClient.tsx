"use client";

import { useAuth } from "@clerk/nextjs";
import { ArrowLeft, Mail, Phone, RefreshCw, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement, RefObject } from "react";
import {
  AdminOrdersApiError,
  addInternalOrderNote,
  adminOrdersErrorMessage,
  confirmAdminShipment,
  fetchAdminOrder,
  fetchAdminOrderTimeline,
  runLifecycleCommand,
  withAdminToken,
} from "./api";
import { AdminOrderDialog } from "./AdminOrderDialog";
import { OrderActionsPanel, actionLabels } from "./OrderActionsPanel";
import { OrderHistoryPanel } from "./OrderHistoryPanel";
import {
  customizationImageStatus, customizationLevel, formatAddress, formatAdminDate,
  formatAdminMoney, formatProductionEstimate, formatProductionSelection,
  snapshotLabel, statusLabel,
} from "./format";
import { validateNote, validateReason, validateShipment } from "./order-workflow";
import type { OrderAction } from "./order-workflow";
import type { AdminOrderDetail, AdminOrderItem, AdminOrderTimelinePage } from "./types";
import { AdminOrdersShell, LoadingPanel, StatePanel, StatusBadge } from "./AdminOrdersUi";

type ProtectedData<T> = { epoch: number; value: T } | null;
type ShipmentForm = { carrier: string; carrierService: string; trackingNumber: string };
type ShipmentErrors = Record<keyof ShipmentForm | "reason", string | null>;
type UnknownOutcome = { accepted?: boolean; action: OrderAction | "note"; baselineRevision: number; noteBody?: string };

const emptyShipment: ShipmentForm = { carrier: "", carrierService: "", trackingNumber: "" };
const emptyShipmentErrors: ShipmentErrors = { carrier: null, carrierService: null, reason: null, trackingNumber: null };
const newKey = () => globalThis.crypto.randomUUID();

function mutationMessage(error: AdminOrdersApiError) {
  const messages: Record<string, string> = {
    ADMIN_ORDERS_UNAVAILABLE: "The order service is temporarily unavailable. Your entries were kept so you can retry.",
    IDEMPOTENCY_CONFLICT: "This action changed after its retry key was created. Close and open it again before retrying.",
    MESSAGE_IDEMPOTENCY_CONFLICT: "This note changed after its retry key was created. Edit it before retrying.",
    ORDER_REVISION_CONFLICT: "The order changed while this action was open. Review the latest state before submitting again.",
    ORDER_TRANSITION_NOT_ALLOWED: "This fulfillment action is no longer available. Review the refreshed order state.",
    SHIPMENT_ALREADY_CONFIRMED: "A shipment is already recorded. Review the refreshed shipment details.",
    VALIDATION_ERROR: "Review the entered values and try again.",
  };
  const message = error.code ? messages[error.code] : null;
  return message
    ? `${message}${error.retryAfterSeconds ? ` Try again in about ${error.retryAfterSeconds} seconds.` : ""}`
    : adminOrdersErrorMessage(error);
}

export function AdminOrderDetailClient({ orderId, returnHref }: { orderId: string; returnHref: string }) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const identity = isLoaded && isSignedIn && userId ? userId : null;
  const epoch = useRef(0);
  const identityRef = useRef(identity);
  const controllers = useRef(new Set<AbortController>());
  const actionHeadingRef = useRef<HTMLHeadingElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const carrierRef = useRef<HTMLInputElement>(null);

  const [detail, setDetail] = useState<ProtectedData<AdminOrderDetail>>(null);
  const [detailError, setDetailError] = useState<AdminOrdersApiError | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [timeline, setTimeline] = useState<ProtectedData<AdminOrderTimelinePage>>(null);
  const [timelineError, setTimelineError] = useState("");
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineLoadingMore, setTimelineLoadingMore] = useState(false);
  const [timelineAppendError, setTimelineAppendError] = useState("");
  const [dialogAction, setDialogAction] = useState<OrderAction | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");
  const [shipment, setShipment] = useState<ShipmentForm>(emptyShipment);
  const [shipmentErrors, setShipmentErrors] = useState<ShipmentErrors>(emptyShipmentErrors);
  const [actionKey, setActionKey] = useState(newKey);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState("");
  const [noteKey, setNoteKey] = useState(newKey);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [mutationsLocked, setMutationsLocked] = useState(false);
  const [unknownOutcome, setUnknownOutcome] = useState<UnknownOutcome | null>(null);

  identityRef.current = identity;
  const currentDetail = detail?.epoch === epoch.current ? detail.value : null;
  const currentTimeline = timeline?.epoch === epoch.current ? timeline.value : null;

  const abortAll = useCallback(() => {
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
  }, []);

  const clearProtectedState = useCallback(() => {
    setDetail(null); setTimeline(null); setDialogAction(null); setReason("");
    setShipment(emptyShipment); setNote(""); setMutationError("");
    setStatusMessage(""); setUnknownOutcome(null); setMutationsLocked(false);
    setActionKey(newKey()); setNoteKey(newKey());
  }, []);

  const controllerFor = useCallback(() => {
    const controller = new AbortController();
    controllers.current.add(controller);
    return controller;
  }, []);
  const releaseController = useCallback((controller: AbortController) => controllers.current.delete(controller), []);

  const authFailure = useCallback((error: AdminOrdersApiError) => {
    if (error.status !== 401 && error.status !== 403) return false;
    abortAll(); clearProtectedState(); setDetailError(error);
    return true;
  }, [abortAll, clearProtectedState]);

  const readDetail = useCallback(async (requestEpoch: number) => {
    const controller = controllerFor();
    try {
      const value = await withAdminToken(getToken, (token) => fetchAdminOrder(token, orderId, controller.signal));
      if (controller.signal.aborted || epoch.current !== requestEpoch || identityRef.current !== identity) return null;
      setDetail({ epoch: requestEpoch, value }); setDetailError(null);
      return value;
    } catch (caught) {
      if (controller.signal.aborted) return null;
      const error = caught instanceof AdminOrdersApiError ? caught : new AdminOrdersApiError("The admin order could not be loaded.", 0);
      if (!authFailure(error) && epoch.current === requestEpoch) setDetailError(error);
      return null;
    } finally { releaseController(controller); }
  }, [authFailure, controllerFor, getToken, identity, orderId, releaseController]);

  const readTimeline = useCallback(async (requestEpoch: number, cursor?: string) => {
    const controller = controllerFor();
    try {
      const value = await withAdminToken(getToken, (token) => fetchAdminOrderTimeline(token, orderId, controller.signal, cursor));
      if (controller.signal.aborted || epoch.current !== requestEpoch || identityRef.current !== identity) return null;
      setTimeline((existing) => {
        if (!cursor || !existing || existing.epoch !== requestEpoch) return { epoch: requestEpoch, value };
        const seen = new Set(existing.value.entries.map((entry) => `${entry.kind}:${entry.id}`));
        return { epoch: requestEpoch, value: { entries: [...existing.value.entries, ...value.entries.filter((entry) => !seen.has(`${entry.kind}:${entry.id}`))], nextCursor: value.nextCursor } };
      });
      setTimelineError(""); setTimelineAppendError("");
      return value;
    } catch (caught) {
      if (controller.signal.aborted) return null;
      const error = caught instanceof AdminOrdersApiError ? caught : new AdminOrdersApiError("Order history could not be loaded.", 0);
      if (authFailure(error)) return null;
      if (epoch.current === requestEpoch) {
        if (cursor) setTimelineAppendError(mutationMessage(error));
        else setTimelineError(mutationMessage(error));
      }
      return null;
    } finally { releaseController(controller); }
  }, [authFailure, controllerFor, getToken, identity, orderId, releaseController]);

  useEffect(() => {
    const requestEpoch = ++epoch.current;
    abortAll(); clearProtectedState(); setDetailError(null); setTimelineError("");
    setDetailLoading(Boolean(identity)); setTimelineLoading(Boolean(identity));
    if (!identity) { setDetailLoading(false); setTimelineLoading(false); return; }
    void readDetail(requestEpoch).finally(() => { if (epoch.current === requestEpoch) setDetailLoading(false); });
    void readTimeline(requestEpoch).finally(() => { if (epoch.current === requestEpoch) setTimelineLoading(false); });
    return () => { epoch.current += 1; abortAll(); };
  }, [abortAll, clearProtectedState, identity, orderId, readDetail, readTimeline]);

  async function verifyMutation(message: string, outcome: UnknownOutcome) {
    const requestEpoch = epoch.current;
    const [nextDetail, nextTimeline] = await Promise.all([readDetail(requestEpoch), readTimeline(requestEpoch)]);
    if (!nextDetail || !nextTimeline) {
      setMutationsLocked(true); setUnknownOutcome({ ...outcome, accepted: true });
      setStatusMessage("Update accepted; latest state unavailable");
      return false;
    }
    setMutationsLocked(false); setUnknownOutcome(null); setStatusMessage(message);
    setDialogAction(null); setReason(""); setShipment(emptyShipment); setActionKey(newKey());
    window.setTimeout(() => actionHeadingRef.current?.focus());
    return true;
  }

  function beginBoundedRequest() {
    const controller = controllerFor();
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    return { controller, finish: () => { window.clearTimeout(timer); releaseController(controller); }, timedOut: () => timedOut };
  }

  async function submitAction(event: FormEvent) {
    event.preventDefault();
    if (!currentDetail || !dialogAction || mutationBusy || mutationsLocked) return;
    const localReasonError = validateReason(reason);
    if (dialogAction === "confirm_shipment") {
      const errors = validateShipment({ ...shipment, reason }); setShipmentErrors(errors);
      if (Object.values(errors).some(Boolean)) return;
    } else { setReasonError(localReasonError ?? ""); if (localReasonError) return; }
    const requestEpoch = epoch.current;
    const baselineRevision = currentDetail.revision;
    const request = beginBoundedRequest(); setMutationBusy(true); setMutationError("");
    try {
      if (dialogAction === "confirm_shipment") {
        await withAdminToken(getToken, (token) => confirmAdminShipment(token, orderId, {
          carrier: shipment.carrier.trim(),
          ...(shipment.carrierService.trim() ? { carrierService: shipment.carrierService.trim() } : {}),
          expectedRevision: currentDetail.revision,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          trackingNumber: shipment.trackingNumber.trim(),
        }, actionKey, request.controller.signal));
      } else {
        await withAdminToken(getToken, (token) => runLifecycleCommand(token, orderId, dialogAction, {
          expectedRevision: currentDetail.revision,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }, actionKey, request.controller.signal));
      }
      if (epoch.current !== requestEpoch) return;
      await verifyMutation(`${actionLabels[dialogAction]} accepted.`, { action: dialogAction, baselineRevision });
    } catch (caught) {
      if (epoch.current !== requestEpoch) return;
      if (request.timedOut()) {
        setMutationsLocked(true); setUnknownOutcome({ action: dialogAction, baselineRevision });
        setMutationError("The request timed out and may have completed. Refresh the order state before retrying.");
      } else if (caught instanceof AdminOrdersApiError) {
        if (authFailure(caught)) return;
        setMutationError(mutationMessage(caught));
        if (caught.status === 409) {
          await Promise.all([readDetail(requestEpoch), readTimeline(requestEpoch)]);
          setActionKey(newKey());
        }
      } else if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setMutationError("The action could not be completed. Your entries were kept so you can retry.");
      }
    } finally { request.finish(); if (epoch.current === requestEpoch) setMutationBusy(false); }
  }

  async function submitNote(event: FormEvent) {
    event.preventDefault();
    if (!currentDetail || noteBusy || mutationsLocked) return;
    const validation = validateNote(note); setNoteError(validation ?? ""); if (validation) return;
    const requestEpoch = epoch.current; const body = note.trim(); const request = beginBoundedRequest(); setNoteBusy(true);
    try {
      await withAdminToken(getToken, (token) => addInternalOrderNote(token, orderId, body, noteKey, request.controller.signal));
      if (epoch.current !== requestEpoch) return;
      const verified = await verifyMutation("Internal note added.", { action: "note", baselineRevision: currentDetail.revision, noteBody: body });
      if (verified) { setNote(""); setNoteKey(newKey()); setNoteError(""); }
    } catch (caught) {
      if (epoch.current !== requestEpoch) return;
      if (request.timedOut()) {
        setMutationsLocked(true); setUnknownOutcome({ action: "note", baselineRevision: currentDetail.revision, noteBody: body });
        setNoteError("The request timed out and may have completed. Refresh the order state before retrying.");
      } else if (caught instanceof AdminOrdersApiError) {
        if (authFailure(caught)) return; setNoteError(mutationMessage(caught));
      } else if (!(caught instanceof DOMException && caught.name === "AbortError")) setNoteError("The note could not be added. Its text was kept so you can retry.");
    } finally { request.finish(); if (epoch.current === requestEpoch) setNoteBusy(false); }
  }

  async function refreshUnknownOutcome() {
    if (!unknownOutcome) return;
    const requestEpoch = epoch.current; setDetailLoading(true); setTimelineLoading(true);
    const [nextDetail, nextTimeline] = await Promise.all([readDetail(requestEpoch), readTimeline(requestEpoch)]);
    setDetailLoading(false); setTimelineLoading(false);
    if (!nextDetail || !nextTimeline) { setStatusMessage("The latest state is still unavailable. Mutations remain paused."); return; }
    const occurred = unknownOutcome.accepted || (unknownOutcome.action === "note"
      ? nextTimeline.entries.some((entry) => entry.kind === "internal_note" && entry.body === unknownOutcome.noteBody)
      : unknownOutcome.action === "start_production"
        ? nextDetail.revision > unknownOutcome.baselineRevision && nextDetail.status === "in_production"
        : unknownOutcome.action === "mark_ready_to_ship"
          ? nextDetail.revision > unknownOutcome.baselineRevision && nextDetail.status === "ready_to_ship"
          : nextDetail.revision > unknownOutcome.baselineRevision && nextDetail.status === "shipped");
    if (occurred) {
      setStatusMessage(unknownOutcome.accepted ? "The update was accepted." : "The timed-out update was accepted."); setDialogAction(null); setReason(""); setShipment(emptyShipment);
      if (unknownOutcome.action === "note") setNote("");
      setUnknownOutcome(null); setMutationsLocked(false); setActionKey(newKey()); setNoteKey(newKey());
      window.setTimeout(() => actionHeadingRef.current?.focus());
    } else if (unknownOutcome.action === "note" || nextDetail.revision === unknownOutcome.baselineRevision) {
      setStatusMessage("The update was not found. You can retry with the same protected request key."); setMutationsLocked(false); setUnknownOutcome(null);
    } else setStatusMessage("The order changed, but the timed-out outcome is inconclusive. Mutations remain paused.");
  }

  function updateReason(value: string) { setReason(value); setReasonError(""); setMutationError(""); setActionKey(newKey()); }
  function updateShipment(field: keyof ShipmentForm, value: string) {
    setShipment((current) => ({ ...current, [field]: value })); setShipmentErrors((current) => ({ ...current, [field]: null })); setMutationError(""); setActionKey(newKey());
  }
  function updateNote(value: string) { setNote(value); setNoteError(""); setNoteKey(newKey()); }

  return (
    <AdminOrdersShell title={currentDetail?.publicOrderNumber ?? "Order detail"} description="Review production details, advance fulfillment, and record internal order history.">
      <Link href={returnHref} className="mb-5 inline-flex h-10 items-center gap-2 rounded-md px-2 text-sm font-semibold text-slate-700 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872]"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to ongoing orders</Link>
      {!isLoaded ? <LoadingPanel label="Checking admin session" variant="detail" /> : !identity ? (
        <StatePanel actionHref="/sign-in" actionLabel="Sign in" title="Admin sign-in required" message="Sign in with an authorized store administrator account to view this order." />
      ) : detailLoading && !currentDetail ? <LoadingPanel label="Loading order detail" variant="detail" /> : detailError && !currentDetail ? (
        detailError.status === 403 ? <StatePanel role="alert" title="Admin access required" message="This account does not have permission to view store orders." />
          : detailError.status === 404 || detailError.status === 400 ? <StatePanel role="alert" actionHref={returnHref} actionLabel="Return to orders" title="Order not found" message="This order is unavailable or its identifier is invalid." />
            : detailError.status === 401 ? <StatePanel role="alert" actionHref="/sign-in" actionLabel="Sign in again" title="Session expired" message="Your admin session could not be refreshed. Sign in again to continue." />
              : <StatePanel role="alert" title="Order unavailable" message={adminOrdersErrorMessage(detailError)} onRetry={() => void readDetail(epoch.current)} />
      ) : currentDetail ? (
        <OrderDetail
          actionHeadingRef={actionHeadingRef} detailError={detailError} detailLoading={detailLoading} mutationsLocked={mutationsLocked}
          noteBusy={noteBusy} noteError={noteError} noteValue={note}
          onLoadMore={() => { if (currentTimeline?.nextCursor) { setTimelineLoadingMore(true); void readTimeline(epoch.current, currentTimeline.nextCursor).finally(() => setTimelineLoadingMore(false)); } }}
          onNoteChange={updateNote} onNoteSubmit={submitNote}
          onOpenAction={(action) => { setDialogAction(action); setMutationError(""); setReasonError(""); setShipmentErrors(emptyShipmentErrors); }}
          onRefreshDetail={() => void readDetail(epoch.current)}
          onRetryTimeline={() => { setTimelineLoading(true); void readTimeline(epoch.current).finally(() => setTimelineLoading(false)); }}
          order={currentDetail} statusMessage={statusMessage} timeline={currentTimeline} timelineAppendError={timelineAppendError}
          timelineError={timelineError} timelineLoading={timelineLoading} timelineLoadingMore={timelineLoadingMore}
        />
      ) : null}
      {mutationsLocked ? <div className="fixed bottom-4 left-4 right-4 z-40 flex flex-col gap-3 border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 shadow-lg sm:left-auto sm:max-w-md sm:flex-row sm:items-center" role="alert"><p className="flex-1">{statusMessage || "Mutations are paused until the latest order state is verified."}</p><button type="button" onClick={() => void refreshUnknownOutcome()} className="h-10 rounded-md border border-amber-400 px-3 font-semibold">Refresh status</button></div> : null}
      {dialogAction ? (
        <AdminOrderDialog busy={mutationBusy} description={dialogAction === "confirm_shipment" ? "This records tracking and marks the order shipped. It does not purchase a label." : `Confirm that this order should ${actionLabels[dialogAction].toLowerCase()}.`} initialFocusRef={dialogAction === "confirm_shipment" ? carrierRef : cancelRef} onClose={() => setDialogAction(null)} title={actionLabels[dialogAction]}>
          <form onSubmit={submitAction} className="space-y-4">
            {dialogAction === "confirm_shipment" ? <>
              <DialogField id="shipment-carrier" label="Carrier" error={shipmentErrors.carrier}><input ref={carrierRef} id="shipment-carrier" value={shipment.carrier} disabled={mutationBusy} aria-invalid={Boolean(shipmentErrors.carrier)} aria-describedby={shipmentErrors.carrier ? "shipment-carrier-error" : undefined} onChange={(event) => updateShipment("carrier", event.target.value)} className="h-11 w-full min-w-0 rounded-md border border-slate-300 px-3" /></DialogField>
              <DialogField id="shipment-service" label="Carrier service (optional)" error={shipmentErrors.carrierService}><input id="shipment-service" value={shipment.carrierService} disabled={mutationBusy} aria-invalid={Boolean(shipmentErrors.carrierService)} aria-describedby={shipmentErrors.carrierService ? "shipment-service-error" : undefined} onChange={(event) => updateShipment("carrierService", event.target.value)} className="h-11 w-full min-w-0 rounded-md border border-slate-300 px-3" /></DialogField>
              <DialogField id="shipment-tracking" label="Tracking number" error={shipmentErrors.trackingNumber}><input id="shipment-tracking" value={shipment.trackingNumber} disabled={mutationBusy} aria-invalid={Boolean(shipmentErrors.trackingNumber)} aria-describedby={shipmentErrors.trackingNumber ? "shipment-tracking-error" : undefined} onChange={(event) => updateShipment("trackingNumber", event.target.value)} className="h-11 w-full min-w-0 rounded-md border border-slate-300 px-3" /></DialogField>
            </> : null}
            <DialogField id="action-reason" label="Internal audit reason (optional)" error={dialogAction === "confirm_shipment" ? shipmentErrors.reason : reasonError || null}><textarea id="action-reason" value={reason} disabled={mutationBusy} rows={3} aria-invalid={Boolean(dialogAction === "confirm_shipment" ? shipmentErrors.reason : reasonError)} aria-describedby={(dialogAction === "confirm_shipment" ? shipmentErrors.reason : reasonError) ? "action-reason-error" : undefined} onChange={(event) => updateReason(event.target.value)} className="w-full min-w-0 resize-y rounded-md border border-slate-300 px-3 py-2" /></DialogField>
            {mutationError ? <p role="alert" className="break-words text-sm text-red-700">{mutationError}</p> : null}
            <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end"><button ref={cancelRef} type="button" disabled={mutationBusy} onClick={() => setDialogAction(null)} className="h-11 rounded-md border border-slate-300 px-4 text-sm font-semibold disabled:opacity-50">Cancel</button><button type="submit" disabled={mutationBusy || mutationsLocked} className="h-11 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white disabled:opacity-50">{mutationBusy ? "Submitting..." : actionLabels[dialogAction]}</button></div>
          </form>
        </AdminOrderDialog>
      ) : null}
    </AdminOrdersShell>
  );
}

function DialogField({ children, error, id, label }: { children: ReactElement; error: string | null; id: string; label: string }) {
  return <div className="min-w-0"><label htmlFor={id} className="block text-sm font-semibold text-slate-700">{label}</label><div className="mt-1.5">{children}</div>{error ? <p id={`${id}-error`} role="alert" className="mt-1 text-sm text-red-700">{error}</p> : null}</div>;
}

type DetailProps = {
  actionHeadingRef: RefObject<HTMLHeadingElement | null>; detailError: AdminOrdersApiError | null; detailLoading: boolean; mutationsLocked: boolean;
  noteBusy: boolean; noteError: string; noteValue: string; onLoadMore: () => void; onNoteChange: (value: string) => void;
  onNoteSubmit: (event: FormEvent) => void; onOpenAction: (action: OrderAction) => void; onRefreshDetail: () => void; onRetryTimeline: () => void;
  order: AdminOrderDetail; statusMessage: string; timeline: AdminOrderTimelinePage | null; timelineAppendError: string; timelineError: string;
  timelineLoading: boolean; timelineLoadingMore: boolean;
};

function OrderDetail(props: DetailProps) {
  const { actionHeadingRef, detailError, detailLoading, mutationsLocked, noteBusy, noteError, noteValue, onLoadMore, onNoteChange, onNoteSubmit, onOpenAction, onRefreshDetail, onRetryTimeline, order, statusMessage, timeline, timelineAppendError, timelineError, timelineLoading, timelineLoadingMore } = props;
  const address = formatAddress(order.shipping.address);
  return <div className="space-y-7">
    {detailLoading ? <p role="status" className="text-sm text-slate-600">Refreshing order...</p> : null}
    {detailError ? <div className="flex flex-wrap items-center justify-between gap-3 border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="alert"><p>Showing last-known order data. {adminOrdersErrorMessage(detailError)}</p><button type="button" onClick={onRefreshDetail} className="inline-flex h-9 items-center gap-2 rounded-md border border-amber-300 px-3 font-semibold"><RefreshCw className="h-4 w-4" aria-hidden="true" /> Retry</button></div> : null}
    <section aria-labelledby="order-summary-heading" className="border-y border-slate-200 bg-white px-4 py-5 sm:px-5"><div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between"><div><h2 id="order-summary-heading" className="text-base font-semibold">Order summary</h2><p className="mt-1 text-sm text-slate-600">Placed {formatAdminDate(order.createdAt)}</p><p className="mt-3 text-2xl font-semibold">{formatAdminMoney(order.total)}</p></div><div className="flex flex-wrap gap-2"><StatusBadge context="Order status" value={order.status} /><StatusBadge context="Payment status" value={order.paymentStatus} /><StatusBadge context="Fulfillment status" value={order.fulfillmentStatus} /></div></div></section>
    <section aria-labelledby="customer-heading"><h2 id="customer-heading" className="mb-3 text-lg font-semibold">Customer and delivery</h2><div className="grid border-y border-slate-200 bg-white md:grid-cols-2 md:divide-x md:divide-slate-200"><dl className="grid gap-4 p-5 text-sm"><ContactRow icon={<UserRound />} label="Name" value={order.contactSnapshot.name ?? "Not provided"} /><ContactRow icon={<Mail />} label="Email" value={order.contactSnapshot.email ?? "Not provided"} /><ContactRow icon={<Phone />} label="Phone" value={order.contactSnapshot.phone ?? "Not provided"} /><div><dt className="text-xs font-semibold uppercase text-slate-500">Preferred contact</dt><dd className="mt-1">{order.contactSnapshot.preferredContactMethod ? statusLabel(order.contactSnapshot.preferredContactMethod) : "Not provided"}</dd></div></dl><div className="border-t border-slate-200 p-5 md:border-t-0"><h3 className="text-sm font-semibold">Shipping address</h3><address className="mt-3 not-italic text-sm leading-6 text-slate-600"><p>{order.shipping.name ?? "Not provided"}</p>{address.length ? address.map((line) => <p key={line}>{line}</p>) : <p>Not provided</p>}</address></div></div></section>
    <section aria-labelledby="items-heading"><div className="mb-3 flex items-end justify-between gap-3"><h2 id="items-heading" className="text-lg font-semibold">Purchased items</h2><p className="text-sm text-slate-600">{order.totalQuantity} total units</p></div><div className="space-y-3">{order.items.map((item, index) => <OrderItemDetail key={item.id} item={item} index={index} />)}</div></section>
    <OrderActionsPanel disabled={mutationsLocked} headingRef={actionHeadingRef} onOpenAction={onOpenAction} order={order} statusMessage={statusMessage} />
    <OrderHistoryPanel appendError={timelineAppendError} loading={timelineLoading} loadingMore={timelineLoadingMore} mutationsDisabled={mutationsLocked} noteBusy={noteBusy} noteError={noteError} noteValue={noteValue} onLoadMore={onLoadMore} onNoteChange={onNoteChange} onNoteSubmit={onNoteSubmit} onRetry={onRetryTimeline} page={timelineError && !timeline ? null : timeline} />
  </div>;
}

function ContactRow({ icon, label, value }: { icon: ReactElement; label: string; value: string }) {
  return <div className="flex gap-3"><span className="mt-0.5 text-slate-400" aria-hidden="true">{icon}</span><div className="min-w-0"><dt className="text-xs font-semibold uppercase text-slate-500">{label}</dt><dd className="mt-1 break-words">{value}</dd></div></div>;
}

function OrderItemDetail({ item, index }: { item: AdminOrderItem; index: number }) {
  const listing = snapshotLabel(item.snapshots.listing, ["title", "name", "label"]) ?? "Kapchi item";
  const fabric = snapshotLabel(item.snapshots.fabric, ["name", "label", "color"]) ?? "Not stored";
  const text = item.production.availability.text === "present" ? [item.production.text.line1, item.production.text.line2].filter(Boolean).join(" / ") || "Stored selection" : item.production.availability.text === "not_selected" ? "Not selected" : "Not stored";
  return <article className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5"><div className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-xs font-semibold uppercase text-[#8f734f]">Item {index + 1}</p><h3 className="mt-1 text-base font-semibold">{listing}</h3><p className="mt-1 text-sm text-slate-600">Fabric: {fabric}</p></div><div className="text-sm sm:text-right"><p>{item.quantity} x {formatAdminMoney(item.unitPrice)}</p><p className="mt-1 font-semibold">{formatAdminMoney(item.total)}</p></div></div><dl className="mt-4 grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3"><Selection label="Customization level" value={customizationLevel(item.snapshots.customization)} /><Selection label="Text" value={text} /><Selection label="Image" value={customizationImageStatus(item)} /><Selection label="Font" value={formatProductionSelection("font", item.production.font, item.production.availability.font)} /><Selection label="Placement" value={formatProductionSelection("placement", item.production.placement, item.production.availability.placement)} /><Selection label="Trim" value={formatProductionSelection("trim", item.production.trim, item.production.availability.trim)} /><Selection label="Production priority" value={item.production.priorityCode ? statusLabel(item.production.priorityCode) : "Not stored"} /><Selection label="Production estimate" value={formatProductionEstimate(item.production.estimateSnapshot)} /></dl><div className="mt-4 border-t border-slate-200 pt-4 text-sm"><p className="text-xs font-semibold uppercase text-slate-500">Production notes</p><p className="mt-1 whitespace-pre-wrap break-words text-slate-900">{item.productionNotes ?? "Not stored"}</p></div>{item.catalogReference.listingStatus === "archived" || item.catalogReference.fabricStatus === "archived" ? <p className="mt-4 border-l-2 border-amber-400 pl-3 text-xs text-slate-600">This item references an archived catalog selection. Stored order details are shown.</p> : null}</article>;
}

function Selection({ label, value }: { label: string; value: string }) { return <div><dt className="text-xs font-semibold uppercase text-slate-500">{label}</dt><dd className="mt-1 break-words text-slate-900">{value}</dd></div>; }
