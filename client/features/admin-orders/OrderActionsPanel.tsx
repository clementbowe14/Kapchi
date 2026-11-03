"use client";

import { ChevronRight, ShoppingCart } from "lucide-react";
import type { RefObject } from "react";
import { formatAdminDate } from "./format";
import { decideOrderAction } from "./order-workflow";
import type { AdminOrderDetail } from "./types";
import { StatusBadge } from "./AdminOrdersUi";

const actionLabels = {
  confirm_shipment: "Confirm shipment",
  mark_ready_to_ship: "Mark ready to ship",
  start_production: "Start production",
} as const;

export function OrderActionsPanel({
  disabled,
  headingRef,
  onOpenAction,
  order,
  statusMessage,
}: {
  disabled: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onOpenAction: (action: keyof typeof actionLabels) => void;
  order: AdminOrderDetail;
  statusMessage: string;
}) {
  const decision = decideOrderAction(order);
  return (
    <section aria-labelledby="order-actions-heading" className="border-y border-slate-200 bg-white px-4 py-5 sm:px-5">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase text-[#8f734f]">Fulfillment workflow</p>
          <h2 ref={headingRef} tabIndex={-1} id="order-actions-heading" className="mt-1 text-lg font-semibold focus:outline-none">
            Next action
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            {decision.action ? `The order is ready to ${actionLabels[decision.action].toLowerCase()}.` : decision.explanation}
          </p>
          {statusMessage ? <p className="mt-3 text-sm font-medium text-slate-800" role="status">{statusMessage}</p> : null}
        </div>
        {decision.action ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onOpenAction(decision.action!)}
            className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2 sm:w-auto"
          >
            <ShoppingCart className="h-4 w-4" aria-hidden="true" />
            {actionLabels[decision.action]}
          </button>
        ) : null}
      </div>

      <div className="mt-6 border-t border-slate-200 pt-5">
        <h3 className="text-sm font-semibold">Shipments</h3>
        {order.shipments.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No shipment has been recorded.</p>
        ) : (
          <div className="mt-3 divide-y divide-slate-200">
            {order.shipments.map((shipment) => {
              const historical = shipment.status === "failed" || shipment.status === "voided";
              return (
                <article key={shipment.id} className="grid min-w-0 gap-3 py-4 sm:grid-cols-[1fr_auto] sm:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">Shipment {shipment.shipmentNumber}</p>
                      <StatusBadge value={shipment.status} />
                      {historical ? <span className="text-xs font-medium text-slate-500">Historical</span> : null}
                    </div>
                    <p className="mt-2 break-words text-sm text-slate-700">
                      {[shipment.carrier, shipment.carrierService].filter(Boolean).join(" · ") || "Carrier not recorded"}
                    </p>
                    {shipment.trackingNumber ? (
                      <p className="mt-1 break-all text-sm text-slate-600">Tracking: {shipment.trackingNumber}</p>
                    ) : <p className="mt-1 text-sm text-slate-600">Tracking not recorded</p>}
                    {shipment.shippedAt ? <p className="mt-1 text-xs text-slate-500">Shipped {formatAdminDate(shipment.shippedAt)}</p> : null}
                  </div>
                  {shipment.trackingUrl ? (
                    <a
                      href={shipment.trackingUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] sm:w-auto"
                    >
                      Track shipment <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </a>
                  ) : shipment.trackingNumber ? (
                    <span className="text-xs text-slate-500">Tracking link unavailable</span>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export { actionLabels };
