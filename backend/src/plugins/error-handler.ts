import type { FastifyError, FastifyInstance } from "fastify";
import Joi from "joi";

type ErrorPayload = {
  error: string;
  message: string;
  statusCode: number;
};

function isFastifyError(error: unknown): error is FastifyError {
  return typeof error === "object" && error !== null && "message" in error;
}

function formatError(error: unknown): ErrorPayload {
  if (error instanceof Joi.ValidationError) {
    return {
      error: "VALIDATION_ERROR",
      message: error.message,
      statusCode: 400
    };
  }

  if (
    isFastifyError(error) &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return {
      error: error.code ?? "REQUEST_ERROR",
      message: error.message,
      statusCode: error.statusCode
    };
  }

  return {
    error: "INTERNAL_SERVER_ERROR",
    message: "An unexpected error occurred.",
    statusCode: 500
  };
}

export function registerErrorHandler(fastify: FastifyInstance) {
  fastify.setErrorHandler((error, request, reply) => {
    const payload = formatError(error);

    void reply.code(payload.statusCode).send(payload);
  });
}
