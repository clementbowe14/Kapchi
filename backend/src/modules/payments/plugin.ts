import fp from "fastify-plugin";
import type {
  FastifyBaseLogger,
  FastifyPluginAsync,
  FastifyReply
} from "fastify";
import Joi from "joi";
import type { Pool } from "pg";
import { config } from "../../config/index.js";
import { authMiddleware } from "../auth/index.js";
import { getGuestCartSessionContext } from "../cart/guest-session.js";
import {
  CheckoutAlreadyCompleteError,
  CheckoutCartNotFoundError,
  CheckoutNeedsReviewError,
  CheckoutProviderError
} from "./checkout-errors.js";
import {
  createCheckoutObserver,
  type CheckoutObserver
} from "./checkout-observer.js";
import {
  StripeCheckoutProvider,
  type CheckoutProvider,
  type StripePaymentsClient
} from "./checkout-provider.js";
import { CheckoutRepository } from "./checkout-repository.js";
import {
  CheckoutService,
  type CheckoutRepositoryPort,
  type CheckoutServiceDependencies,
  type Clock
} from "./checkout-service.js";
import type {
  CheckoutCartOwner,
  CheckoutContact,
  CheckoutResult
} from "./checkout-types.js";
import { createStripeClient } from "./stripe-client.js";

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({
    error: "BAD_REQUEST",
    message,
    statusCode: 400
  });
}

const checkoutSchema = Joi.object<CheckoutContact>({
  customerEmail: Joi.string().trim().lowercase().email().required(),
  customerPhone: Joi.string().trim().min(3).max(64).allow(null).default(null)
}).required();

function parseJsonBody(body: unknown) {
  if (typeof body !== "string") {
    return body;
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

export type PaymentsRuntimeConfig = {
  checkout: {
    cancelUrl: string;
    successUrl: string;
  };
  stripe: {
    webhookSecret: string;
  };
};

export interface CheckoutStarter {
  startCheckout(
    context: CheckoutCartOwner,
    contact: CheckoutContact,
  ): Promise<CheckoutResult>;
}

export type PaymentsPluginDependencies = {
  checkoutProviderFactory?: (
    stripe: StripePaymentsClient,
  ) => CheckoutProvider;
  checkoutRepositoryFactory?: (
    pool: Pick<Pool, "connect" | "query">,
  ) => CheckoutRepositoryPort;
  checkoutServiceFactory?: (
    dependencies: CheckoutServiceDependencies,
  ) => CheckoutStarter;
  clock?: Clock;
  observerFactory?: (
    logger: Pick<FastifyBaseLogger, "error" | "info" | "warn">,
  ) => CheckoutObserver;
  paymentConfig?: PaymentsRuntimeConfig;
  stripeClientFactory?: () => StripePaymentsClient;
};

const systemClock: Clock = { now: () => new Date() };

export function createPaymentsPlugin(
  dependencies: PaymentsPluginDependencies = {},
) {
  const plugin: FastifyPluginAsync = async (fastify) => {
    const paymentConfig = dependencies.paymentConfig ?? config.payments;
    const stripe = dependencies.stripeClientFactory?.() ?? createStripeClient();
    const repository =
      dependencies.checkoutRepositoryFactory?.(fastify.pg) ??
      new CheckoutRepository(fastify.pg);
    const provider =
      dependencies.checkoutProviderFactory?.(stripe) ??
      new StripeCheckoutProvider(stripe);
    const observerFactory =
      dependencies.observerFactory ?? createCheckoutObserver;
    const checkoutServiceFactory =
      dependencies.checkoutServiceFactory ??
      ((serviceDependencies: CheckoutServiceDependencies) =>
        new CheckoutService(serviceDependencies));

    const serviceFor = (logger: FastifyBaseLogger) =>
      checkoutServiceFactory({
        clock: dependencies.clock ?? systemClock,
        observer: observerFactory(logger),
        provider,
        redirects: paymentConfig.checkout,
        repository
      });

    fastify.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, payload, done) => {
        done(null, payload);
      },
    );

    fastify.post(
      "/checkout-sessions",
      { preHandler: [authMiddleware] },
      async (request, reply) => {
        const { error, value } = checkoutSchema.validate(
          parseJsonBody(request.body),
          {
            abortEarly: false,
            allowUnknown: false,
            stripUnknown: false
          },
        );

        if (error) {
          return reply.code(400).send({
            error: "VALIDATION_ERROR",
            message: error.message,
            statusCode: 400
          });
        }

        const owner = request.auth
          ? { authSubject: request.auth.userId }
          : await getGuestCartSessionContext(request);
        if (!owner) {
          return reply.code(404).send({
            error: "CART_NOT_FOUND",
            message: "Cart not found.",
            statusCode: 404
          });
        }

        try {
          const result = await serviceFor(request.log).startCheckout(
            owner,
            value as CheckoutContact,
          );
          return reply.code(201).send(result);
        } catch (checkoutError) {
          if (checkoutError instanceof CheckoutCartNotFoundError) {
            return reply.code(404).send({
              error: "CART_NOT_FOUND",
              message: checkoutError.message,
              statusCode: 404
            });
          }
          if (checkoutError instanceof CheckoutNeedsReviewError) {
            return reply.code(409).send({
              error: "CART_NEEDS_REVIEW",
              message: checkoutError.message,
              statusCode: 409
            });
          }
          if (checkoutError instanceof CheckoutProviderError) {
            return reply.code(502).send({
              error: "CHECKOUT_PROVIDER_ERROR",
              message: checkoutError.message,
              statusCode: 502
            });
          }
          if (checkoutError instanceof CheckoutAlreadyCompleteError) {
            return reply.code(409).send({
              error: "CHECKOUT_ALREADY_COMPLETE",
              message: checkoutError.message,
              statusCode: 409
            });
          }

          throw checkoutError;
        }
      },
    );

    fastify.post("/webhooks/stripe", async (request, reply) => {
      const signature = request.headers["stripe-signature"];

      if (typeof signature !== "string" || signature.length === 0) {
        return badRequest(reply, "Missing Stripe signature.");
      }

      if (typeof request.body !== "string") {
        return badRequest(reply, "Invalid Stripe webhook payload.");
      }

      try {
        const event = stripe.webhooks.constructEvent(
          request.body,
          signature,
          paymentConfig.stripe.webhookSecret,
        );

        return reply.send({
          event_type: event.type,
          received: true
        });
      } catch {
        return badRequest(reply, "Invalid Stripe webhook signature or payload.");
      }
    });
  };

  return fp(plugin, {
    encapsulate: true,
    name: "payments-module"
  });
}

export default createPaymentsPlugin();
