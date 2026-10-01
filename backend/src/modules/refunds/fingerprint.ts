import { createHash } from "node:crypto";
import type { RefundActor, RefundRequest } from "./types.js";

export function refundRequestFingerprint(
  orderId: string,
  actor: RefundActor,
  request: RefundRequest,
) {
  const canonicalFields = [
    "refund-request-v1",
    orderId,
    actor.userId,
    request.amountCents === undefined ? "FULL_REMAINING" : String(request.amountCents),
    request.currency.toLowerCase(),
    request.reasonCode,
    request.reasonNote?.trim() ?? "",
    request.restockRequested ? "1" : "0",
    request.notificationRequested ? "1" : "0"
  ];

  return createHash("sha256")
    .update(JSON.stringify(canonicalFields))
    .digest("hex");
}

