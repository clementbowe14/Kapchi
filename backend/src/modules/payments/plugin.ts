import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import Joi from "joi";
import {
  CheckoutOrderNotFoundError,
  CheckoutOrderStateError,
  CheckoutProviderError,
  CheckoutValidationError
} from "./errors.js";
import { CheckoutSessionService } from "./service.js";

const checkoutSessionSchema = Joi.object({
  order_id: Joi.string().trim().uuid({ version: "uuidv4" }).required(),
  success_url: Joi.string().trim().uri({ scheme: ["http", "https"] }).required(),
  cancel_url: Joi.string().trim().uri({ scheme: ["http", "https"] }).required()
}).required();

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({
    error: "VALIDATION_ERROR",
    message,
    statusCode: 400
  });
}

function parseCheckoutBody(body: unknown) {
  if (typeof body !== "string") {
    return body;
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new CheckoutValidationError("Request body must be valid JSON.");
  }
}

const paymentsPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.post("/checkout-sessions", async (request, reply) => {
    let parsedBody: unknown;

    try {
      parsedBody = parseCheckoutBody(request.body);
    } catch (error) {
      if (error instanceof CheckoutValidationError) {
        return badRequest(reply, error.message);
      }

      throw error;
    }

    const { error, value } = checkoutSessionSchema.validate(parsedBody, {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      return badRequest(reply, error.message);
    }

    const body = value as {
      cancel_url: string;
      order_id: string;
      success_url: string;
    };

    try {
      const session = await new CheckoutSessionService().createCheckoutSession({
        cancelUrl: body.cancel_url,
        orderId: body.order_id,
        successUrl: body.success_url
      });

      return reply.code(201).send(session);
    } catch (error) {
      if (error instanceof CheckoutOrderNotFoundError) {
        return reply.code(404).send({
          error: "ORDER_NOT_FOUND",
          message: error.message,
          statusCode: 404
        });
      }

      if (error instanceof CheckoutOrderStateError) {
        return reply.code(409).send({
          error: "ORDER_NOT_PAYABLE",
          message: error.message,
          statusCode: 409
        });
      }

      if (error instanceof CheckoutProviderError) {
        return reply.code(502).send({
          error: "CHECKOUT_PROVIDER_ERROR",
          message: error.message,
          statusCode: 502
        });
      }

      throw error;
    }
  });
};

export default fp(paymentsPlugin, {
  encapsulate: true,
  name: "payments-module"
});
