import type { Metadata } from "next";
import { AdminOrdersDashboard } from "@/features/admin-orders/AdminOrdersDashboard";

export const metadata: Metadata = {
  title: "Ongoing Orders | Kapchi Admin",
  robots: { follow: false, index: false },
};

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string | string[]; status?: string | string[] }>;
}) {
  const query = await searchParams;
  const sort = typeof query.sort === "string" ? query.sort : undefined;
  const status = typeof query.status === "string" ? query.status : undefined;
  return <AdminOrdersDashboard key={`${status ?? "all"}:${sort ?? "created_desc"}`} initialSort={sort} initialStatus={status} />;
}
