import { PageShell } from "@/components/PageShell";
import { CheckoutConfirmationClient } from "@/app/checkout/confirmation/CheckoutConfirmationClient";
import { OrderLookupClient } from "./OrderLookupClient";

type OrdersPageProps = {
  searchParams: Promise<{
    checkout_session_id?: string | string[];
  }>;
};

export default async function OrdersPage({ searchParams }: OrdersPageProps) {
  const params = await searchParams;
  const checkoutSessionId = Array.isArray(params.checkout_session_id)
    ? params.checkout_session_id[0]
    : params.checkout_session_id;

  if (checkoutSessionId) {
    return (
      <CheckoutConfirmationClient checkoutSessionId={checkoutSessionId} />
    );
  }

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
