import Stripe from "stripe";
import { config } from "../../config/index.js";

let stripeClient: Stripe | undefined;

export function getStripeClient() {
  stripeClient ??= new Stripe(config.payments.stripe.secretKey, {
    apiVersion: config.payments.stripe.apiVersion as Stripe.LatestApiVersion
  });

  return stripeClient;
}
