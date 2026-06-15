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

  DATABASE_MODE: Joi.string()
    .valid("local-postgres", "aurora-dsql")
    .default("local-postgres"),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ["postgres", "postgresql"] })
    .when("DATABASE_MODE", {
      is: "local-postgres",
      then: Joi.required(),
      otherwise: Joi.optional()
    }),
  DATABASE_POOL_MAX: Joi.number().integer().min(1).default(10),
  DATABASE_CONNECTION_TIMEOUT_MS: Joi.number().integer().min(1).default(10000),
  DATABASE_IDLE_TIMEOUT_MS: Joi.number().integer().min(1).default(30000),
  DSQL_HOST: Joi.string().hostname().when("DATABASE_MODE", {
    is: "aurora-dsql",
    then: Joi.required(),
    otherwise: Joi.optional()
  }),
  DSQL_DATABASE: Joi.string().trim().default("postgres"),
  DSQL_USER: Joi.string().trim().when("DATABASE_MODE", {
    is: "aurora-dsql",
    then: Joi.required(),
    otherwise: Joi.optional()
  }),
  DSQL_AUTH_MODE: Joi.string().valid("admin", "custom").when("DATABASE_MODE", {
    is: "aurora-dsql",
    then: Joi.required(),
    otherwise: Joi.optional()
  }),
  DSQL_TOKEN_EXPIRES_IN_SECONDS: Joi.number()
    .integer()
    .min(900)
    .max(604800)
    .default(3600),
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
  DATABASE_URL?: string;
  DATABASE_MODE: "local-postgres" | "aurora-dsql";
  DATABASE_POOL_MAX: number;
  DATABASE_CONNECTION_TIMEOUT_MS: number;
  DATABASE_IDLE_TIMEOUT_MS: number;
  DSQL_AUTH_MODE?: "admin" | "custom";
  DSQL_DATABASE: string;
  DSQL_HOST?: string;
  DSQL_TOKEN_EXPIRES_IN_SECONDS: number;
  DSQL_USER?: string;
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
    auroraDsql: {
      authMode: environment.DSQL_AUTH_MODE,
      database: environment.DSQL_DATABASE,
      host: environment.DSQL_HOST,
      tokenExpiresInSeconds: environment.DSQL_TOKEN_EXPIRES_IN_SECONDS,
      user: environment.DSQL_USER
    },
    connectionTimeoutMs: environment.DATABASE_CONNECTION_TIMEOUT_MS,
    idleTimeoutMs: environment.DATABASE_IDLE_TIMEOUT_MS,
    mode: environment.DATABASE_MODE,
    poolMax: environment.DATABASE_POOL_MAX,
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
