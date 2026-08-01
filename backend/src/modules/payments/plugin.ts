import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import Joi from "joi";
import { config } from "../../config/index.js";
import { getGuestCartSessionContext } from "../cart/guest-session.js";
import {
  CheckoutCartNotFoundError,
  CheckoutNeedsReviewError,
  CheckoutProviderError
} from "./checkout-errors.js";
import { CheckoutRepository } from "./checkout-repository.js";
import { CheckoutService } from "./checkout-service.js";
import type { CheckoutContact } from "./checkout-types.js";
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

const stripe = createStripeClient();

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

const paymentsPlugin: FastifyPluginAsync = async (fastify) => {
  const checkoutService = new CheckoutService(
    new CheckoutRepository(fastify.pg),
    stripe,
  );

  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, payload, done) => {
      done(null, payload);
    },
  );

  fastify.post("/checkout-sessions", async (request, reply) => {
    const { error, value } = checkoutSchema.validate(parseJsonBody(request.body), {
      abortEarly: false,
      allowUnknown: false,
      stripUnknown: false
    });

    if (error) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        message: error.message,
        statusCode: 400
      });
    }

    const context = await getGuestCartSessionContext(request);
    if (!context) {
      return reply.code(404).send({
        error: "CART_NOT_FOUND",
        message: "Cart not found.",
        statusCode: 404
      });
    }

    try {
      const result = await checkoutService.startGuestCheckout(
        context,
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

      throw checkoutError;
    }
  });

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
        config.payments.stripe.webhookSecret,
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

export default fp(paymentsPlugin, {
  encapsulate: true,
  name: "payments-module"
});
