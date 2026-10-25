import type Stripe from "stripe";
import { RefundProviderError } from "./errors.js";
import type {
  ProviderPaymentSnapshot,
  ProviderRefund,
  RefundReasonCode
} from "./types.js";

export type CreateProviderRefundInput = {
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  livemode: boolean;
  operationId: string;
  orderId: string;
  paymentIntentId: string;
  reasonCode: RefundReasonCode;
};

export interface RefundProvider {
  createRefund(input: CreateProviderRefundInput): Promise<ProviderRefund>;
  reconcilePayment(paymentIntentId: string): Promise<ProviderPaymentSnapshot>;
  retrieveRefund(refundId: string, livemode: boolean): Promise<ProviderRefund>;
}

function idOf(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id ?? null;
}

function mapRefund(refund: Stripe.Refund, livemode = false): ProviderRefund {
  const status = (refund.status ?? "pending") as ProviderRefund["status"];
  return {
    amountCents: refund.amount,
    chargeId: idOf(refund.charge),
    createdAt: new Date(refund.created * 1000),
    currency: refund.currency.toLowerCase(),
    failureCode: refund.failure_reason ?? null,
    id: refund.id,
    livemode,
    metadata: {
      ...(refund.metadata?.operation_id
        ? { operationId: refund.metadata.operation_id }
        : {}),
      ...(refund.metadata?.order_id ? { orderId: refund.metadata.order_id } : {})
    },
    paymentIntentId: idOf(refund.payment_intent),
    status
  };
}

function providerError(error: unknown) {
  const candidate = error as {
    code?: string;
    message?: string;
    statusCode?: number;
    type?: string;
  };
  const statusCode = candidate.statusCode;
  const definitive =
    candidate.type === "StripeInvalidRequestError" ||
    (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 && statusCode !== 409 && statusCode !== 429);

  return new RefundProviderError(
    candidate.code ?? candidate.type ?? "STRIPE_REFUND_ERROR",
    definitive ? "Stripe rejected the refund request." : "Stripe refund outcome is not yet known.",
    !definitive,
  );
}

export class StripeRefundProvider implements RefundProvider {
  constructor(private readonly stripe: Stripe) {}

  async createRefund(input: CreateProviderRefundInput) {
    try {
      const refund = await this.stripe.refunds.create(
        {
          amount: input.amountCents,
          metadata: {
            operation_id: input.operationId,
            order_id: input.orderId
          },
          payment_intent: input.paymentIntentId,
          ...(input.reasonCode === "other" ? {} : { reason: input.reasonCode })
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return mapRefund(refund, input.livemode);
    } catch (error) {
      throw providerError(error);
    }
  }

  async retrieveRefund(refundId: string, livemode: boolean) {
    try {
      return mapRefund(await this.stripe.refunds.retrieve(refundId), livemode);
    } catch (error) {
      throw providerError(error);
    }
  }

  async reconcilePayment(paymentIntentId: string) {
    try {
      const [account, paymentIntent] = await Promise.all([
        this.stripe.accounts.retrieve(),
        this.stripe.paymentIntents.retrieve(paymentIntentId, {
          expand: ["latest_charge"]
        })
      ]);
      const latestCharge =
        typeof paymentIntent.latest_charge === "object"
          ? paymentIntent.latest_charge
          : null;
      if (
        paymentIntent.status !== "succeeded" ||
        paymentIntent.amount_received <= 0 ||
        !latestCharge?.captured
      ) {
        throw new RefundProviderError(
          "PAYMENT_NOT_CAPTURED",
          "The payment has not been captured and cannot be refunded.",
          false,
        );
      }

      const refunds: ProviderRefund[] = [];
      let startingAfter: string | undefined;
      do {
        const page = await this.stripe.refunds.list({
          limit: 100,
          payment_intent: paymentIntentId,
          ...(startingAfter ? { starting_after: startingAfter } : {})
        });
        refunds.push(...page.data.map((refund) => mapRefund(refund, paymentIntent.livemode)));
        startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
      } while (startingAfter);

      return {
        apiVersion: null,
        capturedAmountCents: paymentIntent.amount_received,
        currency: paymentIntent.currency.toLowerCase(),
        latestChargeId: latestCharge.id,
        livemode: paymentIntent.livemode,
        paymentIntentId,
        providerAccountId: account.id,
        providerPaymentStatus: paymentIntent.status,
        refunds
      };
    } catch (error) {
      if (error instanceof RefundProviderError) {
        throw error;
      }
      throw providerError(error);
    }
  }
}
