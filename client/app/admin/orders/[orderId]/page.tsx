import type { Metadata } from "next";
import { AdminOrderDetailClient } from "@/features/admin-orders/AdminOrderDetailClient";
import { isOngoingOrderStatus, isOrderSort } from "@/features/admin-orders/types";

export const metadata: Metadata = {
  title: "Order Detail | Kapchi Admin",
  robots: { follow: false, index: false },
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function AdminOrderDetailPage({ params, searchParams }: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ shipmentId?: string | string[]; sort?: string | string[]; status?: string | string[] }>;
}) {
  const [{ orderId }, query] = await Promise.all([params, searchParams]);
  const returnQuery = new URLSearchParams();
  if (isOngoingOrderStatus(query.status)) returnQuery.set("status", query.status);
  if (isOrderSort(query.sort) && query.sort !== "created_desc") returnQuery.set("sort", query.sort);
  const serialized = returnQuery.toString();
  return (
    <AdminOrderDetailClient
      expectedShipmentId={typeof query.shipmentId === "string" && uuidPattern.test(query.shipmentId) ? query.shipmentId : undefined}
      orderId={orderId}
      returnHref={`/admin/orders${serialized ? `?${serialized}` : ""}`}
    />
  );
}
