import type { Pool } from "pg";
import { deriveTrackingUrl, normalizeCarrier } from "../admin-orders/tracking.js";

export type CustomerTracking = {
  carrier: string;
  trackingNumber: string;
  trackingUrl: string | null;
};

type TrackingRow = {
  carrier: string | null;
  order_id: string;
  tracking_number: string | null;
};

export async function loadCustomerTracking(
  database: Pick<Pool, "query">,
  orderIds: string[],
) {
  const tracking = new Map<string, CustomerTracking>();
  if (orderIds.length === 0) return tracking;
  const result = await database.query<TrackingRow>(
    `select distinct on (order_id) order_id, carrier, tracking_number
     from shipments
     where order_id = any($1::uuid[])
       and status in ('in_transit', 'delivered', 'completed')
     order by order_id, shipped_at desc nulls last, shipment_number desc, id desc`,
    [orderIds],
  );
  for (const row of result.rows) {
    if (!row.carrier || !row.tracking_number) continue;
    tracking.set(row.order_id, {
      carrier: normalizeCarrier(row.carrier),
      trackingNumber: row.tracking_number,
      trackingUrl: deriveTrackingUrl(row.carrier, row.tracking_number)
    });
  }
  return tracking;
}
