import { config as loadDotEnv } from "dotenv";
import Joi from "joi";

loadDotEnv();

const environmentSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid("development", "test", "production")
    .default("development"),
  HOST: Joi.string().hostname().allow("0.0.0.0", "localhost").default("0.0.0.0"),
  PORT: Joi.number().port().default(4000),
  LOG_LEVEL: Joi.string()
    .valid("fatal", "error", "warn", "info", "debug", "trace", "silent")
    .default("info"),

  CLERK_PUBLISHABLE_KEY: Joi.string().trim().required(),
  CLERK_SECRET_KEY: Joi.string().trim().required(),
  CLERK_JWT_ISSUER: Joi.string().uri({ scheme: ["http", "https"] }).required(),
  CLERK_JWKS_URL: Joi.string().uri({ scheme: ["http", "https"] }).required(),
  CLERK_WEBHOOK_SECRET: Joi.string().trim().required(),

  STRIPE_SECRET_KEY: Joi.string().trim().required(),
  STRIPE_WEBHOOK_SECRET: Joi.string().trim().required(),
  STRIPE_API_VERSION: Joi.string().trim().default("2026-02-25.clover"),

  DATABASE_URL: Joi.string().uri({ scheme: ["postgres", "postgresql"] }).required(),
  DATABASE_POOL_MAX: Joi.number().integer().min(1).default(10),
  DATABASE_CONNECTION_TIMEOUT_MS: Joi.number().integer().min(1).default(10000),
  DATABASE_IDLE_TIMEOUT_MS: Joi.number().integer().min(1).default(30000),
  REDIS_URL: Joi.string().uri({ scheme: ["redis", "rediss"] }).required()
}).unknown(true);

type EnvironmentShape = {
  CLERK_JWKS_URL: string;
  CLERK_JWT_ISSUER: string;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  CLERK_WEBHOOK_SECRET: string;
  DATABASE_URL: string;
  DATABASE_POOL_MAX: number;
  DATABASE_CONNECTION_TIMEOUT_MS: number;
  DATABASE_IDLE_TIMEOUT_MS: number;
  HOST: string;
  LOG_LEVEL: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  NODE_ENV: "development" | "test" | "production";
  PORT: number;
  REDIS_URL: string;
  STRIPE_API_VERSION: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
};

function buildErrorMessage(error: Joi.ValidationError) {
  return error.details
    .map((detail) => {
      const path = detail.path.join(".") || "environment";
      return `- ${path}: ${detail.message}`;
    })
    .join("\n");
}

function validateEnvironment(): EnvironmentShape {
  const { error, value } = environmentSchema.validate(process.env, {
    abortEarly: false,
    convert: true,
    presence: "required",
    stripUnknown: false
  });

  if (error) {
    throw new Error(
      `Invalid backend environment configuration:\n${buildErrorMessage(error)}`,
    );
  }

  const environment = value as EnvironmentShape;
  environment.DATABASE_SSL_MODE ??=
    environment.NODE_ENV === "production" ? "require" : "disable";

  const availableDatabaseConnections =
    environment.DATABASE_MAX_CONNECTIONS -
    environment.DATABASE_RESERVED_CONNECTIONS;
  const maxPoolPerInstance = Math.floor(
    availableDatabaseConnections / environment.DATABASE_MAX_APP_INSTANCES,
  );

  if (availableDatabaseConnections < environment.DATABASE_MAX_APP_INSTANCES) {
    throw new Error(
      "Invalid backend environment configuration:\n" +
        "- DATABASE_RESERVED_CONNECTIONS must leave at least one connection per app instance",
    );
  }

  if (environment.DATABASE_POOL_MAX > maxPoolPerInstance) {
    throw new Error(
      "Invalid backend environment configuration:\n" +
        `- DATABASE_POOL_MAX (${environment.DATABASE_POOL_MAX}) exceeds the per-instance budget (${maxPoolPerInstance}) from DATABASE_MAX_CONNECTIONS, DATABASE_RESERVED_CONNECTIONS, and DATABASE_MAX_APP_INSTANCES`,
    );
  }

  return value as EnvironmentShape;
}

const environment = validateEnvironment();

export const config = Object.freeze({
  app: {
    host: environment.HOST,
    logLevel: environment.LOG_LEVEL,
    nodeEnv: environment.NODE_ENV,
    port: environment.PORT
  },
  auth: {
    clerk: {
      jwksUrl: environment.CLERK_JWKS_URL,
      jwtIssuer: environment.CLERK_JWT_ISSUER,
      publishableKey: environment.CLERK_PUBLISHABLE_KEY,
      secretKey: environment.CLERK_SECRET_KEY,
      webhookSecret: environment.CLERK_WEBHOOK_SECRET
    }
  },
  cache: {
    redisUrl: environment.REDIS_URL
  },
  database: {
    connectionTimeoutMs: environment.DATABASE_CONNECTION_TIMEOUT_MS,
    idleTimeoutMs: environment.DATABASE_IDLE_TIMEOUT_MS,
    poolMax: environment.DATABASE_POOL_MAX,
    url: environment.DATABASE_URL
  },
  payments: {
    stripe: {
      apiVersion: environment.STRIPE_API_VERSION,
      secretKey: environment.STRIPE_SECRET_KEY,
      webhookSecret: environment.STRIPE_WEBHOOK_SECRET
    }
  }
});

export type AppConfig = typeof config;
