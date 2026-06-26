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

  SHIPPO_API_KEY: Joi.string().trim().required(),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ["postgres", "postgresql"] })
    .required(),
  DATABASE_DIRECT_URL: Joi.string()
    .uri({ scheme: ["postgres", "postgresql"] })
    .optional(),
  DATABASE_POOL_MAX: Joi.number().integer().min(1).max(50).optional().default(5),
  DATABASE_CONNECTION_TIMEOUT_MS: Joi.number()
    .integer()
    .min(250)
    .max(30000)
    .optional()
    .default(5000),
  DATABASE_IDLE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(120000)
    .optional()
    .default(30000),
  DATABASE_STATEMENT_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(120000)
    .optional()
    .default(15000),
  DATABASE_SSL_MODE: Joi.string()
    .valid("disable", "no-verify", "require")
    .optional(),
  DATABASE_MAX_CONNECTIONS: Joi.number()
    .integer()
    .min(5)
    .max(500)
    .optional()
    .default(20),
  DATABASE_RESERVED_CONNECTIONS: Joi.number()
    .integer()
    .min(1)
    .max(50)
    .optional()
    .default(5),
  DATABASE_MAX_APP_INSTANCES: Joi.number()
    .integer()
    .min(1)
    .max(50)
    .optional()
    .default(3),
  REDIS_URL: Joi.string().uri({ scheme: ["redis", "rediss"] }).required(),

  AWS_REGION: Joi.string().trim().required(),
  AWS_ACCESS_KEY_ID: Joi.string().trim().required(),
  AWS_SECRET_ACCESS_KEY: Joi.string().trim().required(),
  S3_BUCKET: Joi.string().trim().required(),
  CLOUDFRONT_BASE_URL: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .required()
}).unknown(true);

type EnvironmentShape = {
  AWS_ACCESS_KEY_ID: string;
  AWS_REGION: string;
  AWS_SECRET_ACCESS_KEY: string;
  CLERK_JWKS_URL: string;
  CLERK_JWT_ISSUER: string;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  CLERK_WEBHOOK_SECRET: string;
  CLOUDFRONT_BASE_URL: string;
  DATABASE_CONNECTION_TIMEOUT_MS: number;
  DATABASE_DIRECT_URL?: string;
  DATABASE_IDLE_TIMEOUT_MS: number;
  DATABASE_MAX_APP_INSTANCES: number;
  DATABASE_MAX_CONNECTIONS: number;
  DATABASE_POOL_MAX: number;
  DATABASE_RESERVED_CONNECTIONS: number;
  DATABASE_SSL_MODE: "disable" | "no-verify" | "require";
  DATABASE_STATEMENT_TIMEOUT_MS: number;
  DATABASE_URL: string;
  HOST: string;
  LOG_LEVEL: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  NODE_ENV: "development" | "test" | "production";
  PORT: number;
  REDIS_URL: string;
  S3_BUCKET: string;
  SHIPPO_API_KEY: string;
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
    deployment: {
      databaseMaxConnections: environment.DATABASE_MAX_CONNECTIONS,
      maxAppInstances: environment.DATABASE_MAX_APP_INSTANCES,
      reservedConnections: environment.DATABASE_RESERVED_CONNECTIONS
    },
    directUrl: environment.DATABASE_DIRECT_URL ?? environment.DATABASE_URL,
    pool: {
      connectionTimeoutMillis: environment.DATABASE_CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: environment.DATABASE_IDLE_TIMEOUT_MS,
      max: environment.DATABASE_POOL_MAX,
      statementTimeoutMillis: environment.DATABASE_STATEMENT_TIMEOUT_MS
    },
    sslMode: environment.DATABASE_SSL_MODE,
    url: environment.DATABASE_URL
  },
  payments: {
    stripe: {
      apiVersion: environment.STRIPE_API_VERSION,
      secretKey: environment.STRIPE_SECRET_KEY,
      webhookSecret: environment.STRIPE_WEBHOOK_SECRET
    }
  },
  shipping: {
    shippo: {
      apiKey: environment.SHIPPO_API_KEY
    }
  },
  storage: {
    aws: {
      accessKeyId: environment.AWS_ACCESS_KEY_ID,
      region: environment.AWS_REGION,
      secretAccessKey: environment.AWS_SECRET_ACCESS_KEY
    },
    cloudFrontBaseUrl: environment.CLOUDFRONT_BASE_URL,
    s3Bucket: environment.S3_BUCKET
  }
});

export type AppConfig = typeof config;
