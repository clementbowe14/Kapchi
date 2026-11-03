"use client";

import { useAuth } from "@clerk/nextjs";
import { Pencil } from "lucide-react";
import { useRef, useState } from "react";
import { AdminOrderDialog } from "@/features/admin-orders/AdminOrderDialog";
import { AdminOrdersApiError, withAdminToken } from "@/features/admin-orders/api";
import type { AdminOrderDetail } from "@/features/admin-orders/types";
import { correctShippingAddress } from "./api";

type Form = {
  city: string;
  line1: string;
  line2: string;
  name: string;
  postalCode: string;
  reason: string;
  state: string;
};

function value(address: Record<string, unknown> | null, field: string) {
  return typeof address?.[field] === "string" ? String(address[field]) : "";
}

function initialForm(order: AdminOrderDetail): Form {
  return {
    city: value(order.shipping.address, "city"),
    line1: value(order.shipping.address, "line1"),
    line2: value(order.shipping.address, "line2"),
    name: order.shipping.name ?? "",
    postalCode: value(order.shipping.address, "postalCode"),
    reason: "",
    state: value(order.shipping.address, "state"),
  };
}

function validate(form: Form) {
  const errors: Partial<Record<keyof Form, string>> = {};
  for (const field of ["name", "line1", "city", "reason"] as const) {
    if (!form[field].trim()) errors[field] = "This field is required.";
  }
  if (!/^[A-Za-z]{2}$/.test(form.state.trim())) errors.state = "Use a two-letter U.S. state code.";
  if (!/^\d{5}(?:-\d{4})?$/.test(form.postalCode.trim())) errors.postalCode = "Use a five-digit ZIP or ZIP+4.";
  if (form.reason.trim().length > 500) errors.reason = "Reason must be 500 characters or fewer.";
  return errors;
}

export function ShippingAddressCorrection({ order, onCorrected }: { order: AdminOrderDetail; onCorrected: () => void }) {
  const { getToken } = useAuth();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(() => initialForm(order));
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const allowed = ["paid", "in_production", "ready_to_ship"].includes(order.status)
    && ["paid", "partially_refunded"].includes(order.paymentStatus);

  function update(field: keyof Form, next: string) {
    setForm((current) => ({ ...current, [field]: next }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setError("");
    setKey(crypto.randomUUID());
  }

  async function submit() {
    const nextErrors = validate(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length || !confirmed) {
      setError(!confirmed ? "Confirm that the address was verified with the customer." : "Review the highlighted fields.");
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    setError("");
    try {
      await withAdminToken(getToken, (token) => correctShippingAddress(token, order.id, {
        address: {
          city: form.city.trim(),
          country: "US",
          line1: form.line1.trim(),
          ...(form.line2.trim() ? { line2: form.line2.trim() } : {}),
          postalCode: form.postalCode.trim(),
          state: form.state.trim().toUpperCase(),
        },
        expectedRevision: order.revision,
        intent: "correct_shipping_address",
        name: form.name.trim(),
        reason: form.reason.trim(),
      }, key, controller.signal));
      setOpen(false);
      onCorrected();
    } catch (caught) {
      const message = caught instanceof AdminOrdersApiError
        ? caught.code === "EXPORT_ALREADY_PREPARED"
          ? "Cancel the prepared export, or release an expired export, before correcting this address."
          : caught.message
        : "The address correction could not be completed. Retry uses the same protected request key.";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) return null;
  return (
    <>
      <button type="button" onClick={() => { setForm(initialForm(order)); setOpen(true); setError(""); setConfirmed(false); setKey(crypto.randomUUID()); }} className="mt-4 inline-flex h-10 items-center gap-2 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872]">
        <Pencil className="h-4 w-4" aria-hidden="true" /> Correct address
      </button>
      {open ? (
        <AdminOrderDialog busy={busy} initialFocusRef={cancelRef} onClose={() => setOpen(false)} title="Correct shipping address" description="Update Kapchi before making any material correction in Pirate Ship. A fresh export will be required.">
          <div className="space-y-4">
            <AddressField field="name" label="Recipient name" value={form.name} error={errors.name} disabled={busy} onChange={update} />
            <AddressField field="line1" label="Address line 1" value={form.line1} error={errors.line1} disabled={busy} onChange={update} />
            <AddressField field="line2" label="Address line 2 (optional)" value={form.line2} error={errors.line2} disabled={busy} onChange={update} />
            <AddressField field="city" label="City" value={form.city} error={errors.city} disabled={busy} onChange={update} />
            <div className="grid grid-cols-2 gap-3"><AddressField field="state" label="State" value={form.state} error={errors.state} disabled={busy} onChange={update} /><AddressField field="postalCode" label="ZIP code" value={form.postalCode} error={errors.postalCode} disabled={busy} onChange={update} /></div>
            <label className="grid gap-1.5 text-sm font-semibold">Internal correction reason<textarea rows={3} value={form.reason} disabled={busy} aria-invalid={Boolean(errors.reason)} onChange={(event) => update("reason", event.target.value)} className="resize-y rounded-md border border-slate-300 px-3 py-2 font-normal" />{errors.reason ? <span className="font-normal text-red-700">{errors.reason}</span> : null}</label>
            <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => { setConfirmed(event.target.checked); setKey(crypto.randomUUID()); setError(""); }} className="mt-1 h-4 w-4" /><span>I verified this address with the customer and understand that any prepared export must be cancelled first.</span></label>
            {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
            <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end"><button ref={cancelRef} type="button" disabled={busy} onClick={() => setOpen(false)} className="h-11 rounded-md border border-slate-300 px-4 text-sm font-semibold">Cancel</button><button type="button" disabled={busy} onClick={() => void submit()} className="h-11 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Saving..." : "Save corrected address"}</button></div>
          </div>
        </AdminOrderDialog>
      ) : null}
    </>
  );
}

function AddressField({ disabled, error, field, label, onChange, value }: { disabled: boolean; error?: string; field: keyof Form; label: string; onChange: (field: keyof Form, value: string) => void; value: string }) {
  const id = `address-${field}`;
  return <label htmlFor={id} className="grid min-w-0 gap-1.5 text-sm font-semibold">{label}<input id={id} value={value} disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => onChange(field, event.target.value)} className="h-11 min-w-0 rounded-md border border-slate-300 px-3 font-normal" />{error ? <span id={`${id}-error`} className="font-normal text-red-700">{error}</span> : null}</label>;
}
