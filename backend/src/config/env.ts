import Joi from "joi";
import {
  loadBackendEnvironment,
  type BackendEnvironmentSource
} from "./load-environment.js";
import { validateOrderLookupBaseUrl } from "../modules/transactional-notifications/lookup-url.js";

const environmentSource = loadBackendEnvironment();

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
  STRIPE_CHECKOUT_SUCCESS_URL: Joi.when("NODE_ENV", {
    is: "production",
    then: Joi.string().uri({ scheme: ["https"] }).required(),
    otherwise: Joi.string()
      .uri({ scheme: ["http", "https"] })
      .default("http://localhost:3000/checkout/confirmation")
  }),
  STRIPE_CHECKOUT_CANCEL_URL: Joi.when("NODE_ENV", {
    is: "production",
    then: Joi.string().uri({ scheme: ["https"] }).required(),
    otherwise: Joi.string()
      .uri({ scheme: ["http", "https"] })
      .default("http://localhost:3000/cart")
  }),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ["postgres", "postgresql"] })
    .required(),
  DATABASE_DIRECT_URL: Joi.string()
    .uri({ scheme: ["postgres", "postgresql"] })
    .optional(),
  DATABASE_POOL_MAX: Joi.number().integer().min(1).default(5),
  DATABASE_CONNECTION_TIMEOUT_MS: Joi.number().integer().min(1).default(5000),
  DATABASE_IDLE_TIMEOUT_MS: Joi.number().integer().min(1).default(30000),
  DATABASE_STATEMENT_TIMEOUT_MS: Joi.number().integer().min(1).default(15000),
  DATABASE_SSL_MODE: Joi.string()
    .valid("disable", "require", "no-verify")
    .optional(),
  DATABASE_MAX_CONNECTIONS: Joi.number().integer().min(1).default(20),
  DATABASE_RESERVED_CONNECTIONS: Joi.number().integer().min(0).default(5),
  DATABASE_MAX_APP_INSTANCES: Joi.number().integer().min(1).default(3),
  ASSET_UPLOAD_ALLOWED_IMAGE_TYPES: Joi.string()
    .trim()
    .default("image/jpeg,image/png,image/webp"),
  ASSET_UPLOAD_CALLBACK_SECRET: Joi.string().trim().optional(),
  ASSET_UPLOAD_MAX_IMAGE_BYTES: Joi.number()
    .integer()
    .min(1)
    .default(5 * 1024 * 1024),
  ASSET_PRIVATE_OPEN_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(15000)
    .default(5000),
  ASSET_PRIVATE_IDLE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(60000)
    .default(15000),
  ASSET_PRIVATE_TOTAL_TIMEOUT_MS: Joi.number()
    .integer()
    .min(5000)
    .max(120000)
    .default(60000),
  ASSET_PRIVATE_CROSS_ORIGIN_POLICY: Joi.string()
    .valid("same-origin", "same-site", "cross-origin")
    .default("same-site"),
  BLOB_READ_WRITE_TOKEN: Joi.string().trim().optional(),
  BLOB_STORE_ID: Joi.string().trim().optional(),
  VERCEL_OIDC_TOKEN: Joi.string().trim().optional(),
  MESSAGE_DELIVERY_URL: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .optional(),
  MESSAGE_DELIVERY_TOKEN: Joi.string().trim().optional(),
  MESSAGE_WEBHOOK_SECRET: Joi.string().trim().optional(),
  MESSAGE_FROM_EMAIL: Joi.string().trim().email().optional(),
  MESSAGE_FROM_SMS: Joi.string().trim().optional(),
  ORDER_LOOKUP_BASE_URL: Joi.when("NODE_ENV", {
    is: "production",
    then: Joi.string().required(),
    otherwise: Joi.string().default("http://localhost:3000")
  }),
  REDIS_URL: Joi.string().uri({ scheme: ["redis", "rediss"] }).required()
}).unknown(true);

type EnvironmentShape = {
  ASSET_PRIVATE_CROSS_ORIGIN_POLICY: "cross-origin" | "same-origin" | "same-site";
  ASSET_PRIVATE_IDLE_TIMEOUT_MS: number;
  ASSET_PRIVATE_OPEN_TIMEOUT_MS: number;
  ASSET_PRIVATE_TOTAL_TIMEOUT_MS: number;
  ASSET_UPLOAD_ALLOWED_IMAGE_TYPES: string;
  ASSET_UPLOAD_CALLBACK_SECRET?: string;
  ASSET_UPLOAD_MAX_IMAGE_BYTES: number;
  BLOB_READ_WRITE_TOKEN?: string;
  BLOB_STORE_ID?: string;
  CLERK_JWKS_URL: string;
  CLERK_JWT_ISSUER: string;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  CLERK_WEBHOOK_SECRET: string;
  DATABASE_URL: string;
  DATABASE_DIRECT_URL?: string;
  DATABASE_POOL_MAX: number;
  DATABASE_CONNECTION_TIMEOUT_MS: number;
  DATABASE_IDLE_TIMEOUT_MS: number;
  DATABASE_STATEMENT_TIMEOUT_MS: number;
  DATABASE_SSL_MODE?: "disable" | "require" | "no-verify";
  DATABASE_MAX_CONNECTIONS: number;
  DATABASE_RESERVED_CONNECTIONS: number;
  DATABASE_MAX_APP_INSTANCES: number;
  HOST: string;
  LOG_LEVEL: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  MESSAGE_DELIVERY_TOKEN?: string;
  MESSAGE_DELIVERY_URL?: string;
  MESSAGE_FROM_EMAIL?: string;
  MESSAGE_FROM_SMS?: string;
  MESSAGE_WEBHOOK_SECRET?: string;
  NODE_ENV: "development" | "test" | "production";
  ORDER_LOOKUP_BASE_URL: string;
  PORT: number;
  REDIS_URL: string;
  STRIPE_API_VERSION: string;
  STRIPE_CHECKOUT_CANCEL_URL: string;
  STRIPE_CHECKOUT_SUCCESS_URL: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  VERCEL_OIDC_TOKEN?: string;
};

type ValidatedEnvironmentShape = EnvironmentShape & {
  DATABASE_SSL_MODE: "disable" | "require" | "no-verify";
};

function buildErrorMessage(error: Joi.ValidationError) {
  return error.details
    .map((detail) => {
      const path = detail.path.join(".") || "environment";
      return `- ${path}: ${detail.message}`;
    })
    .join("\n");
}

function buildEnvironmentSourceMessage(source: BackendEnvironmentSource) {
  const fileState = source.envFileLoaded ? "loaded" : "not found";

  return `Environment inputs: process variables plus ${source.envFilePath} (${fileState}).`;
}

function buildEnvironmentGuidance(error: Joi.ValidationError) {
  const stripeSecretKeyInvalid = error.details.some(
    (detail) => detail.path.join(".") === "STRIPE_SECRET_KEY",
  );

  if (!stripeSecretKeyInvalid) {
    return "";
  }

  return (
    "\nStripe credentials: STRIPE_SECRET_KEY must be an application API key. " +
    "STRIPE_WEBHOOK_SECRET only verifies webhooks, and Stripe CLI authentication is stored separately."
  );
}

export function validateEnvironment(
  environmentInput: NodeJS.ProcessEnv = process.env,
  source: BackendEnvironmentSource = environmentSource,
): ValidatedEnvironmentShape {
  const { error, value } = environmentSchema.validate(environmentInput, {
    abortEarly: false,
    convert: true,
    stripUnknown: false
  });

  if (error) {
    throw new Error(
      [
        "Invalid backend environment configuration:",
        buildErrorMessage(error),
        buildEnvironmentSourceMessage(source) + buildEnvironmentGuidance(error)
      ].join("\n"),
    );
  }

  const environment = value as EnvironmentShape;
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

  try {
    validateOrderLookupBaseUrl(
      environment.ORDER_LOOKUP_BASE_URL,
      environment.NODE_ENV,
    );
  } catch (error) {
    throw new Error(
      "Invalid backend environment configuration:\n" +
        `- ORDER_LOOKUP_BASE_URL: ${error instanceof Error ? error.message : "invalid URL"}`,
    );
  }

  return {
    ...environment,
    DATABASE_SSL_MODE:
      environment.DATABASE_SSL_MODE ??
      (environment.NODE_ENV === "production" ? "require" : "disable")
  };
}

const environment = validateEnvironment(process.env, environmentSource);

export const config = Object.freeze({
  app: {
    host: environment.HOST,
    logLevel: environment.LOG_LEVEL,
    nodeEnv: environment.NODE_ENV,
    port: environment.PORT
  },
  assets: {
    allowedImageContentTypes: environment.ASSET_UPLOAD_ALLOWED_IMAGE_TYPES.split(
      ",",
    )
      .map((contentType) => contentType.trim())
      .filter(Boolean),
    maxImageBytes: environment.ASSET_UPLOAD_MAX_IMAGE_BYTES,
    privateReads: {
      crossOriginPolicy: environment.ASSET_PRIVATE_CROSS_ORIGIN_POLICY,
      idleTimeoutMs: environment.ASSET_PRIVATE_IDLE_TIMEOUT_MS,
      openTimeoutMs: environment.ASSET_PRIVATE_OPEN_TIMEOUT_MS,
      totalTimeoutMs: environment.ASSET_PRIVATE_TOTAL_TIMEOUT_MS,
      vercel: {
        oidcToken: environment.VERCEL_OIDC_TOKEN,
        storeId: environment.BLOB_STORE_ID,
        token: environment.BLOB_READ_WRITE_TOKEN
      }
    },
    uploadCallbackSecret: environment.ASSET_UPLOAD_CALLBACK_SECRET
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
    directUrl: environment.DATABASE_DIRECT_URL,
    pool: {
      connectionTimeoutMillis: environment.DATABASE_CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: environment.DATABASE_IDLE_TIMEOUT_MS,
      max: environment.DATABASE_POOL_MAX,
      statementTimeoutMillis: environment.DATABASE_STATEMENT_TIMEOUT_MS
    },
    sslMode: environment.DATABASE_SSL_MODE,
    url: environment.DATABASE_URL
  },
  messaging: {
    delivery: {
      token: environment.MESSAGE_DELIVERY_TOKEN,
      url: environment.MESSAGE_DELIVERY_URL
    },
    senders: {
      email: environment.MESSAGE_FROM_EMAIL,
      sms: environment.MESSAGE_FROM_SMS
    },
    webhookSecret: environment.MESSAGE_WEBHOOK_SECRET
  },
  payments: {
    checkout: {
      cancelUrl: environment.STRIPE_CHECKOUT_CANCEL_URL,
      successUrl: environment.STRIPE_CHECKOUT_SUCCESS_URL
    },
    stripe: {
      apiVersion: environment.STRIPE_API_VERSION,
      secretKey: environment.STRIPE_SECRET_KEY,
      webhookSecret: environment.STRIPE_WEBHOOK_SECRET
    }
  }
});

export type AppConfig = typeof config;
