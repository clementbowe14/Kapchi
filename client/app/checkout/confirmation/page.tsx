import { CheckoutConfirmationClient } from "./CheckoutConfirmationClient";

type ConfirmationPageProps = {
  searchParams: Promise<{
    checkout_session_id?: string | string[];
  }>;
};

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CheckoutConfirmationPage({
  searchParams,
}: ConfirmationPageProps) {
  const params = await searchParams;

  return (
    <CheckoutConfirmationClient
      checkoutSessionId={firstValue(params.checkout_session_id) ?? null}
    />
  );
}
