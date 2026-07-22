import Stripe from "stripe";
import { config, type AppConfig } from "../../config/index.js";

type PaymentsConfig = Pick<AppConfig, "payments">;

export type StripeConstructor = new (
  apiKey: string,
  config: Stripe.StripeConfig,
) => Stripe;

type CreateStripeClientOptions = {
  appConfig?: PaymentsConfig;
  StripeCtor?: StripeConstructor;
};

export function createStripeClient({
  appConfig = config,
  StripeCtor = Stripe,
}: CreateStripeClientOptions = {}) {
  const stripeConfig = appConfig.payments.stripe;

  return new StripeCtor(stripeConfig.secretKey, {
    apiVersion: stripeConfig.apiVersion as Stripe.LatestApiVersion
  });
}
