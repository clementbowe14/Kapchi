import fp from "fastify-plugin";
import type {
  FastifyBaseLogger,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest
} from "fastify";
import Joi from "joi";
import type { Pool, PoolClient } from "pg";
import type Stripe from "stripe";
import { config } from "../../config/index.js";
import { safeErrorDetails } from "../../observability/safe-error.js";
import { authMiddleware } from "../auth/index.js";
import { getGuestCartSessionContext } from "../cart/guest-session.js";
import {
  CheckoutAlreadyCompleteError,
  CheckoutCatalogUnavailableError,
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
import {
  handleCheckoutSessionCompleted,
  handlePaymentIntentSucceeded
} from "./success-state.js";
import type {
  CheckoutCartOwner,
  CheckoutContact,
  CheckoutRequest,
  CheckoutResult
} from "./checkout-types.js";
import { createStripeClient } from "./stripe-client.js";
import { StripeRefundProvider } from "../refunds/provider.js";
import {
  StripeWebhookInbox,
  type StripeWebhookInboxPort
} from "../refunds/webhook-inbox.js";

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({
    error: "BAD_REQUEST",
    message,
    statusCode: 400
  });
}

const preferredContactMethods = ["email", "phone", "sms"] as const;

function normalizedPhone(value: string) {
  if (!/^[+0-9().\-\s]+$/.test(value)) {
    return null;
  }

  const plusCount = Array.from(value).filter((character) => character === "+").length;
  if (plusCount > 1 || (plusCount === 1 && !value.startsWith("+"))) {
    return null;
  }

  const digits = value.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    return null;
  }

  return value.startsWith("+") ? `+${digits}` : digits;
}

const checkoutSchema = Joi.object<CheckoutRequest>({
  cartId: Joi.string().guid().optional(),
  cartRevision: Joi.number().integer().min(0).optional(),
  customerEmail: Joi.string().trim().lowercase().email().required(),
  customerPhone: Joi.string()
    .trim()
    .max(64)
    .custom((value: string, helpers) =>
      normalizedPhone(value) ?? helpers.error("string.pattern.base"),
    )
    .allow(null)
    .default(null),
  preferredContactMethod: Joi.string()
    .valid(...preferredContactMethods)
    .required()
})
  .and("cartId", "cartRevision")
  .required();

function validateCheckoutContact(
  body: unknown,
  authenticated: boolean,
): { error?: Joi.ValidationError; value: CheckoutRequest } {
  const result = checkoutSchema.validate(parseJsonBody(body), {
    abortEarly: false,
    allowUnknown: false,
    stripUnknown: false
  });

  if (result.error) {
    return {
      error: result.error,
      value: result.value as CheckoutRequest
    };
  }

  const contact = result.value as CheckoutRequest;
  const phoneRequired =
    !authenticated || contact.preferredContactMethod !== "email";

  if (phoneRequired && !contact.customerPhone) {
    return {
      error: new Joi.ValidationError(
        "Customer phone is required for this checkout.",
        [],
        contact,
      ),
      value: contact
    };
  }

  return { error: undefined, value: contact };
}

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

function observeSafely(
  observer: CheckoutObserver,
  level: "error" | "info" | "warn",
  event: Parameters<CheckoutObserver["info"]>[0],
  fields?: Parameters<CheckoutObserver["info"]>[1],
) {
  try {
    observer[level](event, fields);
  } catch {
    // Diagnostics must never change payment behavior.
  }
}

function checkoutNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: "CHECKOUT_NOT_FOUND",
    message: "Checkout not found.",
    statusCode: 404
  });
}

const checkoutSessionParamsSchema = Joi.object({
  checkoutSessionId: Joi.string()
    .trim()
    .pattern(/^cs_[A-Za-z0-9_]{3,252}$/)
    .required()
}).required();

async function resolveCheckoutOwner(
  request: FastifyRequest,
  checkoutRequest: Pick<CheckoutRequest, "cartId" | "cartRevision"> = {},
) {
  if (request.auth) {
    return {
      authSubject: request.auth.userId,
      ...(checkoutRequest.cartId ? { cartId: checkoutRequest.cartId } : {}),
      ...(checkoutRequest.cartRevision === undefined
        ? {}
        : { expectedRevision: checkoutRequest.cartRevision })
    } satisfies CheckoutCartOwner;
  }

  const context = await getGuestCartSessionContext(request);
  if (
    !context ||
    (checkoutRequest.cartId && checkoutRequest.cartId !== context.cartId)
  ) {
    return null;
  }

  return {
    ...context,
    ...(checkoutRequest.cartRevision === undefined
      ? {}
      : { expectedRevision: checkoutRequest.cartRevision })
  } satisfies CheckoutCartOwner;
}

async function withPoolClient<T>(
  pool: Pick<Pool, "connect">,
  callback: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();

  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

function isPaidCheckoutSession(session: Stripe.Checkout.Session) {
  return (
    session.payment_status === "paid" ||
    session.payment_status === "no_payment_required"
  );
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
  webhookInboxFactory?: (pool: Pool) => StripeWebhookInboxPort;
};

const systemClock: Clock = { now: () => new Date() };

export function createPaymentsPlugin(
  dependencies: PaymentsPluginDependencies = {},
) {
  const plugin: FastifyPluginAsync = async (fastify) => {
    const paymentConfig = dependencies.paymentConfig ?? config.payments;
    const stripe = dependencies.stripeClientFactory?.() ?? createStripeClient();
    const webhookInbox =
      dependencies.webhookInboxFactory?.(fastify.pg) ??
      (typeof (fastify as unknown as { pg?: { query?: unknown } }).pg?.query === "function"
        ? new StripeWebhookInbox(
            fastify.pg,
            new StripeRefundProvider(stripe as unknown as Stripe),
          )
        : null);
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
        const observer = observerFactory(request.log);
        const authMode = request.auth ? "authenticated" : "guest";
        const { error, value } = validateCheckoutContact(
          request.body,
          Boolean(request.auth),
        );

        if (error) {
          observeSafely(observer, "warn", "checkout.contact.rejected", {
            authMode,
            resultCode: "VALIDATION_ERROR"
          });
          return reply.code(400).send({
            error: "VALIDATION_ERROR",
            message: error.message,
            statusCode: 400
          });
        }

        observeSafely(observer, "info", "checkout.contact.accepted", {
          authMode,
          resultCode: "VALID"
        });

        const checkoutRequest = value as CheckoutRequest;
        const owner = await resolveCheckoutOwner(request, checkoutRequest);
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
            {
              customerEmail: checkoutRequest.customerEmail,
              customerPhone: checkoutRequest.customerPhone,
              preferredContactMethod: checkoutRequest.preferredContactMethod
            },
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
            observeSafely(observer, "warn", "checkout.review.required", {
              authMode,
              resultCode: "CART_NEEDS_REVIEW",
              reviewIssueCount: checkoutError.issues.length
            });
            return reply.code(409).send({
              error: "CART_NEEDS_REVIEW",
              issues: checkoutError.issues,
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
          if (checkoutError instanceof CheckoutCatalogUnavailableError) {
            return reply.code(503).send({
              error: checkoutError.code,
              message: checkoutError.message,
              statusCode: 503
            });
          }
          if (checkoutError instanceof CheckoutAlreadyCompleteError) {
            return reply.code(409).send({
              checkoutSessionId: checkoutError.checkoutSessionId,
              error: "CHECKOUT_ALREADY_COMPLETE",
              message: checkoutError.message,
              orderId: checkoutError.orderId,
              publicOrderNumber: checkoutError.publicOrderNumber,
              statusCode: 409
            });
          }

          throw checkoutError;
        }
      },
    );

    fastify.get<{ Params: { checkoutSessionId: string } }>(
      "/checkout-sessions/:checkoutSessionId/status",
      { preHandler: [authMiddleware] },
      async (request, reply) => {
        const observer = observerFactory(request.log);
        const authMode = request.auth ? "authenticated" : "guest";
        const { error, value } = checkoutSessionParamsSchema.validate(
          request.params,
          { allowUnknown: false, stripUnknown: false },
        );

        if (error) {
          return reply.code(400).send({
            error: "VALIDATION_ERROR",
            message: error.message,
            statusCode: 400
          });
        }

        const owner = await resolveCheckoutOwner(request);
        if (!owner) {
          observeSafely(observer, "warn", "checkout.status.denied", {
            authMode,
            resultCode: "OWNER_NOT_FOUND"
          });
          return checkoutNotFound(reply);
        }

        const status = await repository.getCheckoutStatus(
          owner,
          (value as { checkoutSessionId: string }).checkoutSessionId,
        );
        if (!status) {
          observeSafely(observer, "warn", "checkout.status.denied", {
            authMode,
            resultCode: "OWNERSHIP_MISMATCH"
          });
          return checkoutNotFound(reply);
        }

        observeSafely(observer, "info", "checkout.status.read", {
          authMode,
          resultCode: "FOUND"
        });
        return reply.send(status);
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

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(
          request.body,
          signature,
          paymentConfig.stripe.webhookSecret,
        );
      } catch {
        return badRequest(reply, "Invalid Stripe webhook signature or payload.");
      }

      const observer = observerFactory(request.log);
      const eventFields = {
        webhookEventId: event.id,
        webhookEventType: event.type
      };
      observeSafely(observer, "info", "stripe.webhook.verified", eventFields);

      try {
        if (webhookInbox) {
          const received = await webhookInbox.receive(event, request.body);
          observeSafely(observer, "info", "stripe.webhook.processed", {
            ...eventFields,
            resultCode: received.processingStatus
          });
          return reply.send({
            event_type: event.type,
            received: true
          });
        }

        let outcome:
          | Awaited<ReturnType<typeof handleCheckoutSessionCompleted>>
          | null = null;

        if (event.type === "checkout.session.completed") {
          const session = event.data.object as Stripe.Checkout.Session;
          if (isPaidCheckoutSession(session)) {
            outcome = await withPoolClient(fastify.pg, (client) =>
              handleCheckoutSessionCompleted(client, session),
            );
          }
        } else if (event.type === "payment_intent.succeeded") {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          outcome = await withPoolClient(fastify.pg, (client) =>
            handlePaymentIntentSucceeded(client, paymentIntent),
          );
        }

        if (outcome) {
          observeSafely(observer, "info", "stripe.webhook.processed", {
            ...eventFields,
            webhookOutcome: outcome.outcome
          });
        } else {
          observeSafely(observer, "info", "stripe.webhook.ignored", eventFields);
        }

        return reply.send({
          event_type: event.type,
          received: true
        });
      } catch (processingError) {
        observeSafely(observer, "error", "stripe.webhook.failed", {
          ...eventFields,
          ...safeErrorDetails(processingError)
        });
        return reply.code(503).send({
          error: "WEBHOOK_PROCESSING_ERROR",
          message: "Unable to process webhook event.",
          statusCode: 503
        });
      }
    });
  };

  return fp(plugin, {
    encapsulate: true,
    name: "payments-module"
  });
}

export default createPaymentsPlugin();
