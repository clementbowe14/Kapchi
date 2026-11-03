import type { Metadata } from "next";
import { ShippingExportsPage } from "@/features/admin-shipping/ShippingExportsPage";

export const metadata: Metadata = {
  title: "Shipping Exports | Kapchi Admin",
  robots: { follow: false, index: false },
};

export default function AdminShippingExportsPage() {
  return <ShippingExportsPage />;
}
