import type { Metadata } from "next";
import { AdminOrderDetailClient } from "@/features/admin-orders/AdminOrderDetailClient";
import { isOngoingOrderStatus, isOrderSort } from "@/features/admin-orders/types";

export const metadata: Metadata = {
  title: "Order Detail | Kapchi Admin",
  robots: { follow: false, index: false },
};

export default async function AdminOrderDetailPage({ params, searchParams }: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ sort?: string | string[]; status?: string | string[] }>;
}) {
  const [{ orderId }, query] = await Promise.all([params, searchParams]);
  const returnQuery = new URLSearchParams();
  if (isOngoingOrderStatus(query.status)) returnQuery.set("status", query.status);
  if (isOrderSort(query.sort) && query.sort !== "created_desc") returnQuery.set("sort", query.sort);
  const serialized = returnQuery.toString();
  return (
    <AdminOrderDetailClient
      orderId={orderId}
      returnHref={`/admin/orders${serialized ? `?${serialized}` : ""}`}
    />
  );
}
