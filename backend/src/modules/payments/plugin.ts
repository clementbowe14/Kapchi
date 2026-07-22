import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import Stripe from "stripe";
import { config } from "../../config/index.js";

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({
    error: "BAD_REQUEST",
    message,
    statusCode: 400
  });
}

const stripe = new Stripe(config.payments.stripe.secretKey, {
  apiVersion: config.payments.stripe.apiVersion as Stripe.LatestApiVersion
});

const paymentsPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, payload, done) => {
      done(null, payload);
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
