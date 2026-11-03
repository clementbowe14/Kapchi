"use client";

import { Mail, RefreshCw } from "lucide-react";
import type { FormEvent } from "react";
import { formatAdminDate, formatAdminMoney, statusLabel } from "./format";
import type { AdminOrderTimelinePage, TimelineLifecycleState, TimelineView } from "./types";

function lifecycleLabel(state: TimelineLifecycleState | null) {
  if (!state) return "Not available";
  return `${statusLabel(state.orderStatus)} / ${statusLabel(state.fulfillmentStatus)}`;
}

function timelineTitle(entry: TimelineView) {
  if (entry.kind === "internal_note") return "Internal note";
  if (entry.kind === "message") return `${statusLabel(entry.channel)} message`;
  if (entry.kind === "refund") return "Refund update";
  const labels = {
    "order.production_started": "Production started",
    "order.ready_to_ship": "Ready to ship",
    "order.shipment_confirmed": "Shipment confirmed",
    "order.updated": "Order updated",
  };
  return labels[entry.eventType];
}

function TimelineEntry({ entry }: { entry: TimelineView }) {
  return (
    <li className="grid min-w-0 gap-2 border-t border-slate-200 py-4 sm:grid-cols-[10rem_1fr] sm:gap-5">
      <div className="text-xs text-slate-500">
        <p>{formatAdminDate(entry.occurredAt)}</p>
        <p className="mt-1 break-words">{entry.actorName}</p>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold">{timelineTitle(entry)}</p>
          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${entry.visibility === "internal" ? "bg-slate-100 text-slate-700" : "bg-emerald-50 text-emerald-700"}`}>
            {entry.visibility === "internal" ? "Internal" : "Customer visible"}
          </span>
        </div>
        {entry.kind === "event" ? (
          <p className="mt-2 break-words text-sm text-slate-600">{lifecycleLabel(entry.from)} to {lifecycleLabel(entry.to)}</p>
        ) : entry.kind === "internal_note" ? (
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-800">{entry.body}</p>
        ) : entry.kind === "message" ? (
          <div className="mt-2 text-sm text-slate-700">
            <p>{statusLabel(entry.direction)} · {statusLabel(entry.status)}</p>
            {entry.subject ? <p className="mt-1 break-words font-medium">{entry.subject}</p> : null}
            <p className="mt-1 whitespace-pre-wrap break-words">{entry.body}</p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-700">{formatAdminMoney({ amountMinor: entry.amountMinor, currency: entry.currency })} · {statusLabel(entry.status)}</p>
        )}
      </div>
    </li>
  );
}

export function OrderHistoryPanel({
  appendError,
  loading,
  loadingMore,
  mutationsDisabled,
  noteBusy,
  noteError,
  noteValue,
  onLoadMore,
  onNoteChange,
  onNoteSubmit,
  onRetry,
  page,
}: {
  appendError: string;
  loading: boolean;
  loadingMore: boolean;
  mutationsDisabled: boolean;
  noteBusy: boolean;
  noteError: string;
  noteValue: string;
  onLoadMore: () => void;
  onNoteChange: (value: string) => void;
  onNoteSubmit: (event: FormEvent) => void;
  onRetry: () => void;
  page: AdminOrderTimelinePage | null;
}) {
  const trimmedCount = noteValue.trim().length;
  return (
    <section aria-labelledby="order-history-heading" className="border-y border-slate-200 bg-white px-4 py-5 sm:px-5">
      <div className="flex items-start gap-3">
        <Mail className="mt-0.5 h-5 w-5 text-[#8f734f]" aria-hidden="true" />
        <div>
          <h2 id="order-history-heading" className="text-lg font-semibold">Order history</h2>
          <p className="mt-1 text-sm text-slate-600">Newest activity appears first.</p>
        </div>
      </div>

      <form onSubmit={onNoteSubmit} className="mt-6 border-y border-slate-200 bg-slate-50 px-3 py-4 sm:px-4">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-slate-500" aria-hidden="true" />
          <h3 className="text-sm font-semibold">Internal note</h3>
        </div>
        <p id="internal-note-help" className="mt-1 text-sm text-slate-600">Customers cannot see this note.</p>
        <label htmlFor="internal-note" className="mt-3 block text-sm font-semibold text-slate-700">Note</label>
        <textarea
          id="internal-note"
          value={noteValue}
          disabled={noteBusy || mutationsDisabled}
          maxLength={10_001}
          aria-invalid={Boolean(noteError)}
          aria-describedby={`internal-note-help internal-note-count${noteError ? " internal-note-error" : ""}`}
          onChange={(event) => onNoteChange(event.target.value)}
          rows={4}
          className="mt-1.5 w-full min-w-0 resize-y rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] disabled:opacity-60"
        />
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p id="internal-note-count" className="text-xs text-slate-500">{trimmedCount.toLocaleString()} / 10,000 characters</p>
            {noteError ? <p id="internal-note-error" role="alert" className="mt-1 text-sm text-red-700">{noteError}</p> : null}
          </div>
          <button type="submit" disabled={noteBusy || mutationsDisabled} className="h-11 w-full rounded-md bg-slate-950 px-4 text-sm font-semibold text-white disabled:opacity-50 sm:w-auto">
            {noteBusy ? "Adding note..." : "Add note"}
          </button>
        </div>
      </form>

      <div className="mt-6">
        {loading && !page ? <p role="status" className="text-sm text-slate-600">Loading order history...</p> : null}
        {!loading && !page ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p>Order history is temporarily unavailable. The order details above are unchanged.</p>
            <button type="button" onClick={onRetry} className="inline-flex h-9 items-center gap-2 rounded-md border border-amber-300 px-3 font-semibold">
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Retry history
            </button>
          </div>
        ) : null}
        {page?.entries.length === 0 ? <p className="text-sm text-slate-600">No order history has been recorded.</p> : null}
        {page?.entries.length ? <ol>{page.entries.map((entry) => <TimelineEntry key={`${entry.kind}:${entry.id}`} entry={entry} />)}</ol> : null}
        {appendError ? <p role="alert" className="mt-3 text-sm text-red-700">{appendError}</p> : null}
        {page?.nextCursor ? (
          <button type="button" disabled={loadingMore} onClick={onLoadMore} className="mt-4 h-11 w-full rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 disabled:opacity-50 sm:w-auto">
            {loadingMore ? "Loading..." : appendError ? "Retry loading more history" : "Load more history"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
