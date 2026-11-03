import { sanitizePlainText } from "./safety.js";
import type {
  NotificationChannel,
  NotificationItemSummary,
  NotificationKind,
  RenderedNotification,
  TransactionalNotificationPayload
} from "./types.js";

function currencyDigits(currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      currency,
      style: "currency"
    }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    throw new Error("MESSAGE_PAYLOAD_INVALID");
  }
}

export function formatMinorUnits(amount: number, currency: string) {
  if (!Number.isSafeInteger(amount) || amount < 0 || !/^[a-z]{3}$/i.test(currency)) {
    throw new Error("MESSAGE_PAYLOAD_INVALID");
  }
  const normalized = currency.toUpperCase();
  const divisor = 10 ** currencyDigits(normalized);
  return new Intl.NumberFormat("en-US", {
    currency: normalized,
    style: "currency"
  }).format(amount / divisor);
}

export function safeItemSummaries(items: unknown[]) {
  const summaries: NotificationItemSummary[] = [];
  for (const item of items.slice(0, 10)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const title = sanitizePlainText(row.title, 120);
    const quantity = Number(row.quantity);
    if (!title || !Number.isSafeInteger(quantity) || quantity <= 0) continue;
    summaries.push({ quantity, title });
  }
  return summaries;
}

function bounded(value: string, limit: number) {
  return value.length <= limit ? value : value.slice(0, limit).trimEnd();
}

function itemLines(items: NotificationItemSummary[] | undefined, additionalItemCount = 0) {
  if (!items?.length) return [];
  const visible = items.slice(0, 10).map((item) => `${item.quantity} x ${sanitizePlainText(item.title, 120)}`);
  const hidden = Math.max(0, items.length - visible.length) + additionalItemCount;
  return hidden > 0 ? [...visible, `and ${hidden} more items`] : visible;
}

export function renderNotification(
  kind: NotificationKind,
  channel: NotificationChannel,
  payload: TransactionalNotificationPayload,
): RenderedNotification {
  const orderNumber = sanitizePlainText(payload.publicOrderNumber, 80);
  const lookupUrl = sanitizePlainText(payload.lookupUrl, 500);
  if (!orderNumber || !lookupUrl) throw new Error("MESSAGE_PAYLOAD_INVALID");

  let subject: string;
  let lines: string[];
  switch (kind) {
    case "order.confirmed": {
      if (payload.totalAmountMinor === undefined || !payload.currency) {
        throw new Error("MESSAGE_PAYLOAD_INVALID");
      }
      subject = `Order ${orderNumber} confirmed`;
      lines = [
        `Your order ${orderNumber} is confirmed.`,
        ...itemLines(payload.items, payload.additionalItemCount),
        `Total: ${formatMinorUnits(payload.totalAmountMinor, payload.currency)}.`,
        `View your order: ${lookupUrl}`
      ];
      break;
    }
    case "order.cancelled":
      subject = `Order ${orderNumber} cancelled`;
      lines = [`Order ${orderNumber} has been cancelled.`, `View your order: ${lookupUrl}`];
      break;
    case "refund.completed": {
      if (payload.refundAmountMinor === undefined || !payload.currency) {
        throw new Error("MESSAGE_PAYLOAD_INVALID");
      }
      subject = `Refund completed for order ${orderNumber}`;
      lines = [
        `A refund of ${formatMinorUnits(payload.refundAmountMinor, payload.currency)} has been completed for order ${orderNumber}.`,
        `View your order: ${lookupUrl}`
      ];
      break;
    }
    case "order.shipped": {
      subject = `Order ${orderNumber} shipped`;
      lines = [`Order ${orderNumber} has shipped.`];
      const carrier = sanitizePlainText(payload.carrier, 80);
      const trackingNumber = sanitizePlainText(payload.trackingNumber, 120);
      if (carrier) lines.push(`Carrier: ${carrier}.`);
      if (trackingNumber) lines.push(`Tracking number: ${trackingNumber}.`);
      if (payload.trackingUrl) lines.push(`Track shipment: ${sanitizePlainText(payload.trackingUrl, 500)}`);
      lines.push(`View your order: ${lookupUrl}`);
      break;
    }
    case "order.delivered":
      subject = `Order ${orderNumber} delivered`;
      lines = [`Order ${orderNumber} has been delivered.`, `View your order: ${lookupUrl}`];
      break;
  }

  return {
    body: bounded(lines.join("\n"), channel === "sms" ? 480 : 10_000),
    subject: bounded(subject, 160)
  };
}
