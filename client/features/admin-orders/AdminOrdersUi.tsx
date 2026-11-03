import Link from "next/link";
import { AlertCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { statusLabel } from "./format";

export function AdminOrdersShell({
  children,
  description,
  eyebrow = "Store administration",
  title,
}: {
  children: ReactNode;
  description: string;
  eyebrow?: string;
  title: string;
}) {
  return (
    <main className="flex-1 bg-[#f6f7f9] text-slate-950">
      <div className="mx-auto w-full max-w-[90rem] px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-7 border-b border-slate-200 pb-5">
          <p className="text-xs font-semibold uppercase text-[#8f734f]">{eyebrow}</p>
          <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">{title}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{description}</p>
        </header>
        {children}
      </div>
    </main>
  );
}

export function StatusBadge({ context, value }: { context?: string; value: string }) {
  const negativeStatuses = new Set(["cancelled", "failed", "payment_failed", "refunded"]);
  const positiveStatuses = new Set(["delivered", "paid", "ready_to_ship", "succeeded"]);
  const tone = negativeStatuses.has(value)
    ? "border-red-200 bg-red-50 text-red-700"
    : positiveStatuses.has(value)
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : "border-amber-200 bg-amber-50 text-amber-800";
  return (
    <span
      aria-label={context ? `${context}: ${statusLabel(value)}` : undefined}
      className={`inline-flex min-h-7 items-center rounded-full border px-2.5 text-xs font-semibold ${tone}`}
    >
      {statusLabel(value)}
    </span>
  );
}

export function LoadingPanel({
  label,
  variant = "list",
}: {
  label: string;
  variant?: "detail" | "list";
}) {
  const rows = variant === "detail" ? 3 : 5;
  return (
    <div className="min-h-80 border-y border-slate-200 bg-white p-5" role="status" aria-label={label}>
      <p className="sr-only">{label}</p>
      <div className="animate-pulse space-y-4 motion-reduce:animate-none" aria-hidden="true">
        <div className="h-5 w-40 rounded bg-slate-200" />
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className={variant === "detail"
              ? "h-24 rounded bg-slate-100"
              : "grid h-14 grid-cols-4 items-center gap-4 border-t border-slate-100"}
          >
            {variant === "list" ? Array.from({ length: 4 }, (__, cell) => (
              <span key={cell} className="h-3 rounded bg-slate-100" />
            )) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function StatePanel({
  actionHref,
  actionLabel,
  buttonLabel = "Retry",
  message,
  onRetry,
  role = "status",
  title,
}: {
  actionHref?: string;
  actionLabel?: string;
  buttonLabel?: string;
  message: string;
  onRetry?: () => void;
  role?: "alert" | "status";
  title: string;
}) {
  return (
    <section className="border-y border-slate-200 bg-white px-5 py-14 text-center" role={role}>
      <AlertCircle className="mx-auto h-7 w-7 text-[#8f734f]" aria-hidden="true" />
      <h2 className="mt-3 text-lg font-semibold">{title}</h2>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-600">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 inline-flex h-11 items-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2"
        >
          {buttonLabel === "Retry" ? <RefreshCw className="h-4 w-4" aria-hidden="true" /> : null}
          {buttonLabel}
        </button>
      ) : actionHref && actionLabel ? (
        <Link
          href={actionHref}
          className="mt-5 inline-flex h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2"
        >
          {actionLabel}
        </Link>
      ) : null}
    </section>
  );
}
