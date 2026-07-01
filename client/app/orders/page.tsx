import { PageShell } from "@/components/PageShell";
import { OrderLookupClient } from "./OrderLookupClient";

export default function OrdersPage() {
  return (
    <PageShell
      eyebrow="Orders"
      title="Look up an order."
      description="Enter your order ID with the email or phone number used at checkout, or review your account orders when signed in."
    >
      <OrderLookupClient />
    </PageShell>
  );
}
