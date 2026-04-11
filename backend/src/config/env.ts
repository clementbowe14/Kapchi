import { config as loadDotEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Joi from "joi";

const configDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(configDirectory, "../..");

for (const envFileName of [".env.devel", ".env"]) {
  const envFilePath = resolve(packageRoot, envFileName);

  if (existsSync(envFilePath)) {
    loadDotEnv({ path: envFilePath });
  }
}

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

  STRIPE_SECRET_KEY: Joi.string().trim().required(),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ["postgres", "postgresql"] })
    .required(),
  REDIS_URL: Joi.string().uri({ scheme: ["redis", "rediss"] }).required(),

  AWS_REGION: Joi.string().trim().required(),
}).unknown(true);

type EnvironmentShape = {
  AWS_REGION: string;
  CLERK_JWKS_URL: string;
  CLERK_JWT_ISSUER: string;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  DATABASE_URL: string;
  HOST: string;
  LOG_LEVEL: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  NODE_ENV: "development" | "test" | "production";
  PORT: number;
  REDIS_URL: string;
  STRIPE_SECRET_KEY: string;
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
      secretKey: environment.CLERK_SECRET_KEY
    }
  },
  cache: {
    redisUrl: environment.REDIS_URL
  },
  database: {
    url: environment.DATABASE_URL
  },
  payments: {
    stripe: {
      secretKey: environment.STRIPE_SECRET_KEY
    }
  },
  storage: {
    aws: {
      region: environment.AWS_REGION
    }
  }
});

export type AppConfig = typeof config;
