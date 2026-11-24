import { createHash } from "node:crypto";
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
  KAPCHI_ENVIRONMENT: Joi.string()
    .valid("local", "test", "staging", "production")
    .optional(),
  HOST: Joi.string().hostname().allow("0.0.0.0", "localhost").default("0.0.0.0"),
  PORT: Joi.number().port().default(4000),
  LOG_LEVEL: Joi.string()
    .valid("fatal", "error", "warn", "info", "debug", "trace", "silent")
    .default("info"),
  CORS_ALLOWED_ORIGINS: Joi.string().trim().default("http://localhost:3000,http://127.0.0.1:3000"),
  RELEASE_SHA: Joi.string().trim().optional(),
  RELEASE_DEPLOYMENT_ID: Joi.string().trim().optional(),
  RELEASE_ENVIRONMENT_IDENTITY_MARKER: Joi.string().min(32).optional(),
  RELEASE_SCENARIO_REGISTRY_VERSION: Joi.string().trim().max(128).optional(),
  VERCEL: Joi.string().valid("1").optional(),
  VERCEL_ENV: Joi.string().valid("production", "preview", "development").optional(),
  VERCEL_GIT_COMMIT_SHA: Joi.string().trim().optional(),
  VERCEL_DEPLOYMENT_ID: Joi.string().trim().optional(),
  CRON_SECRET: Joi.string().trim().optional(),

  CLERK_PUBLISHABLE_KEY: Joi.string().trim().required(),
  CLERK_SECRET_KEY: Joi.string().trim().required(),
  CLERK_JWT_ISSUER: Joi.string().uri({ scheme: ["http", "https"] }).required(),
  CLERK_JWKS_URL: Joi.string().uri({ scheme: ["http", "https"] }).required(),
  CLERK_JWT_AUDIENCE: Joi.string().trim().optional(),
  CLERK_AUTHORIZED_PARTIES: Joi.string().trim().optional(),
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
  ASSET_UPLOAD_CALLBACK_SECRET_CURRENT: Joi.string().trim().optional(),
  ASSET_UPLOAD_CALLBACK_KEY_ID_CURRENT: Joi.string().trim().pattern(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS: Joi.string().trim().optional(),
  ASSET_UPLOAD_CALLBACK_KEY_ID_PREVIOUS: Joi.string().trim().pattern(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS_EXPIRES_AT: Joi.string().isoDate().optional(),
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
  MESSAGE_CANARY_DESTINATION: Joi.string().trim().optional(),
  REDIS_URL: Joi.string().uri({ scheme: ["redis", "rediss"] }).required()
}).unknown(true);

type EnvironmentShape = {
  ASSET_PRIVATE_CROSS_ORIGIN_POLICY: "cross-origin" | "same-origin" | "same-site";
  ASSET_PRIVATE_IDLE_TIMEOUT_MS: number;
  ASSET_PRIVATE_OPEN_TIMEOUT_MS: number;
  ASSET_PRIVATE_TOTAL_TIMEOUT_MS: number;
  ASSET_UPLOAD_ALLOWED_IMAGE_TYPES: string;
  ASSET_UPLOAD_CALLBACK_SECRET?: string;
  ASSET_UPLOAD_CALLBACK_SECRET_CURRENT?: string;
  ASSET_UPLOAD_CALLBACK_KEY_ID_CURRENT?: string;
  ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS?: string;
  ASSET_UPLOAD_CALLBACK_KEY_ID_PREVIOUS?: string;
  ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS_EXPIRES_AT?: string;
  ASSET_UPLOAD_MAX_IMAGE_BYTES: number;
  BLOB_READ_WRITE_TOKEN?: string;
  BLOB_STORE_ID?: string;
  CLERK_JWKS_URL: string;
  CLERK_JWT_ISSUER: string;
  CLERK_JWT_AUDIENCE?: string;
  CLERK_AUTHORIZED_PARTIES?: string;
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
  CORS_ALLOWED_ORIGINS: string;
  CRON_SECRET?: string;
  DATABASE_MAX_APP_INSTANCES: number;
  HOST: string;
  LOG_LEVEL: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  MESSAGE_DELIVERY_TOKEN?: string;
  MESSAGE_DELIVERY_URL?: string;
  MESSAGE_FROM_EMAIL?: string;
  MESSAGE_FROM_SMS?: string;
  MESSAGE_WEBHOOK_SECRET?: string;
  MESSAGE_CANARY_DESTINATION?: string;
  NODE_ENV: "development" | "test" | "production";
  KAPCHI_ENVIRONMENT?: "local" | "test" | "staging" | "production";
  ORDER_LOOKUP_BASE_URL: string;
  PORT: number;
  REDIS_URL: string;
  RELEASE_DEPLOYMENT_ID?: string;
  RELEASE_ENVIRONMENT_IDENTITY_MARKER?: string;
  RELEASE_SCENARIO_REGISTRY_VERSION?: string;
  RELEASE_SHA?: string;
  STRIPE_API_VERSION: string;
  STRIPE_CHECKOUT_CANCEL_URL: string;
  STRIPE_CHECKOUT_SUCCESS_URL: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  VERCEL_OIDC_TOKEN?: string;
  VERCEL?: "1";
  VERCEL_DEPLOYMENT_ID?: string;
  VERCEL_ENV?: "development" | "preview" | "production";
  VERCEL_GIT_COMMIT_SHA?: string;
};

type ValidatedEnvironmentShape = EnvironmentShape & {
  DATABASE_SSL_MODE: "disable" | "require" | "no-verify";
  KAPCHI_ENVIRONMENT: "local" | "test" | "staging" | "production";
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

function splitList(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isExactOrigin(value: string, requireHttps: boolean) {
  try {
    const url = new URL(value);
    return (!requireHttps || url.protocol === "https:") &&
      ["http:", "https:"].includes(url.protocol) &&
      url.origin === value &&
      !url.username &&
      !url.password;
  } catch {
    return false;
  }
}

function deployedEnvironment(environment: EnvironmentShape) {
  return environment.VERCEL === "1" || Boolean(environment.VERCEL_ENV);
}

function resolvedKapchiEnvironment(environment: EnvironmentShape) {
  return environment.KAPCHI_ENVIRONMENT ??
    (environment.NODE_ENV === "production"
      ? "production"
      : environment.NODE_ENV === "test" ? "test" : "local");
}

function environmentMatrixErrors(environment: EnvironmentShape) {
  const errors: string[] = [];
  const kapchiEnvironment = resolvedKapchiEnvironment(environment);
  const permittedNodeEnvironments = {
    local: new Set(["development", "test"]),
    test: new Set(["test"]),
    staging: new Set(["production"]),
    production: new Set(["production"])
  } as const;

  if (deployedEnvironment(environment) && !environment.KAPCHI_ENVIRONMENT) {
    errors.push("- KAPCHI_ENVIRONMENT: is required for deployed environments");
  }
  if (!permittedNodeEnvironments[kapchiEnvironment].has(environment.NODE_ENV as never)) {
    errors.push(`- KAPCHI_ENVIRONMENT: ${kapchiEnvironment} cannot run with NODE_ENV=${environment.NODE_ENV}`);
  }

  return errors;
}

function productionConfigurationErrors(environment: EnvironmentShape) {
  const kapchiEnvironment = resolvedKapchiEnvironment(environment);
  if (!["staging", "production"].includes(kapchiEnvironment)) return [];

  const errors: string[] = [];
  const origins = splitList(environment.CORS_ALLOWED_ORIGINS);
  const parties = splitList(environment.CLERK_AUTHORIZED_PARTIES);
  const require = (name: keyof EnvironmentShape, present: boolean) => {
    if (!present) errors.push(`- ${name}: is required in production`);
  };
  const secureSecret = (name: keyof EnvironmentShape, value: string | undefined) => {
    if (value && Buffer.byteLength(value, "utf8") < 32) {
      errors.push(`- ${name}: must contain at least 32 bytes in production`);
    }
  };
  const requireHttps = (name: keyof EnvironmentShape, value: string | undefined) => {
    if (value && !value.startsWith("https://")) {
      errors.push(`- ${name}: must use HTTPS in production`);
    }
  };

  require("DATABASE_DIRECT_URL", Boolean(environment.DATABASE_DIRECT_URL));
  require("CLERK_JWT_AUDIENCE", Boolean(environment.CLERK_JWT_AUDIENCE));
  require("CLERK_AUTHORIZED_PARTIES", parties.length > 0);
  if (!(environment.RELEASE_SHA || environment.VERCEL_GIT_COMMIT_SHA)) {
    errors.push("- RELEASE_SHA: set RELEASE_SHA or expose VERCEL_GIT_COMMIT_SHA");
  }
  if (!(environment.RELEASE_DEPLOYMENT_ID || environment.VERCEL_DEPLOYMENT_ID)) {
    errors.push("- RELEASE_DEPLOYMENT_ID: set RELEASE_DEPLOYMENT_ID or expose VERCEL_DEPLOYMENT_ID");
  }
  require("CRON_SECRET", Boolean(environment.CRON_SECRET));
  require("BLOB_READ_WRITE_TOKEN", Boolean(environment.BLOB_READ_WRITE_TOKEN));
  require("ASSET_UPLOAD_CALLBACK_SECRET_CURRENT", Boolean(environment.ASSET_UPLOAD_CALLBACK_SECRET_CURRENT));
  require("ASSET_UPLOAD_CALLBACK_KEY_ID_CURRENT", Boolean(environment.ASSET_UPLOAD_CALLBACK_KEY_ID_CURRENT));
  if (environment.ASSET_UPLOAD_CALLBACK_SECRET) {
    errors.push("- ASSET_UPLOAD_CALLBACK_SECRET: legacy callback authentication is forbidden in production");
  }

  if (origins.length !== 1 || !isExactOrigin(origins[0] ?? "", true)) {
    errors.push("- CORS_ALLOWED_ORIGINS: must contain exactly one HTTPS origin in production");
  }
  if (new Set(origins).size !== origins.length || origins.some((origin) => origin === "*")) {
    errors.push("- CORS_ALLOWED_ORIGINS: contains a duplicate or wildcard origin");
  }
  if (parties.some((party) => !isExactOrigin(party, true))) {
    errors.push("- CLERK_AUTHORIZED_PARTIES: must contain exact HTTPS origins");
  }
  if (new Set(parties).size !== parties.length) {
    errors.push("- CLERK_AUTHORIZED_PARTIES: contains a duplicate origin");
  }
  if (origins.length === 1 && !parties.includes(origins[0])) {
    errors.push("- CLERK_AUTHORIZED_PARTIES: must include the production client origin");
  }

  requireHttps("CLERK_JWT_ISSUER", environment.CLERK_JWT_ISSUER);
  requireHttps("CLERK_JWKS_URL", environment.CLERK_JWKS_URL);
  requireHttps("MESSAGE_DELIVERY_URL", environment.MESSAGE_DELIVERY_URL);
  if (environment.REDIS_URL && !environment.REDIS_URL.startsWith("rediss://")) {
    errors.push("- REDIS_URL: must use TLS (rediss://) in production");
  }
  if (environment.DATABASE_SSL_MODE === "disable" || environment.DATABASE_SSL_MODE === "no-verify") {
    errors.push("- DATABASE_SSL_MODE: must verify TLS in production");
  }
  const stripeIsTest = /^(sk_test_|rk_test_)/i.test(environment.STRIPE_SECRET_KEY);
  const clerkPublishableIsTest = /^pk_test_/i.test(environment.CLERK_PUBLISHABLE_KEY);
  const clerkSecretIsTest = /^sk_test_/i.test(environment.CLERK_SECRET_KEY);
  if (kapchiEnvironment === "production") {
    if (stripeIsTest || /^(test|placeholder)/i.test(environment.STRIPE_SECRET_KEY)) {
      errors.push("- STRIPE_SECRET_KEY: test or placeholder credentials are forbidden in production");
    }
    for (const [name, value] of [
      ["CLERK_PUBLISHABLE_KEY", environment.CLERK_PUBLISHABLE_KEY],
      ["CLERK_SECRET_KEY", environment.CLERK_SECRET_KEY]
    ] as const) {
      if (/^(pk_test_|sk_test_|test|placeholder)/i.test(value)) {
        errors.push(`- ${name}: test or placeholder credentials are forbidden in production`);
      }
    }
  } else {
    if (!stripeIsTest) {
      errors.push("- STRIPE_SECRET_KEY: staging requires a Stripe test-mode key");
    }
    if (!clerkPublishableIsTest || !clerkSecretIsTest) {
      errors.push("- CLERK_PUBLISHABLE_KEY: staging requires Clerk test-instance keys");
    }
    let databaseName = "";
    try {
      databaseName = new URL(environment.DATABASE_URL).pathname.toLowerCase();
    } catch {
      // Joi reports malformed database URLs before this safety check runs.
    }
    if (!/(staging|test)/.test(databaseName) || /(prod|production|live)/.test(databaseName)) {
      errors.push("- DATABASE_URL: staging database name must contain staging or test and must not look like production");
    }
    if (environment.MESSAGE_DELIVERY_URL && !environment.MESSAGE_CANARY_DESTINATION) {
      errors.push("- MESSAGE_CANARY_DESTINATION: staging messaging must use an explicit allowlisted destination");
    }
  }

  secureSecret("CLERK_WEBHOOK_SECRET", environment.CLERK_WEBHOOK_SECRET);
  secureSecret("STRIPE_WEBHOOK_SECRET", environment.STRIPE_WEBHOOK_SECRET);
  secureSecret("ASSET_UPLOAD_CALLBACK_SECRET_CURRENT", environment.ASSET_UPLOAD_CALLBACK_SECRET_CURRENT);
  secureSecret("ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS", environment.ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS);
  secureSecret("MESSAGE_WEBHOOK_SECRET", environment.MESSAGE_WEBHOOK_SECRET);
  secureSecret("CRON_SECRET", environment.CRON_SECRET);

  const previousFields = [
    environment.ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS,
    environment.ASSET_UPLOAD_CALLBACK_KEY_ID_PREVIOUS,
    environment.ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS_EXPIRES_AT
  ];
  if (previousFields.some(Boolean) && !previousFields.every(Boolean)) {
    errors.push("- ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS: previous callback rotation fields must be configured together");
  }
  if (environment.ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS_EXPIRES_AT) {
    const expiry = Date.parse(environment.ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS_EXPIRES_AT);
    if (!Number.isFinite(expiry) || expiry > Date.now() + 24 * 60 * 60 * 1000) {
      errors.push("- ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS_EXPIRES_AT: overlap must not exceed 24 hours");
    }
  }
  if (environment.ASSET_UPLOAD_CALLBACK_KEY_ID_CURRENT &&
      environment.ASSET_UPLOAD_CALLBACK_KEY_ID_CURRENT === environment.ASSET_UPLOAD_CALLBACK_KEY_ID_PREVIOUS) {
    errors.push("- ASSET_UPLOAD_CALLBACK_KEY_ID_PREVIOUS: must differ from the current key ID");
  }
  if (environment.VERCEL_OIDC_TOKEN || environment.BLOB_STORE_ID) {
    errors.push("- VERCEL_OIDC_TOKEN: backend production runtime must use BLOB_READ_WRITE_TOKEN only");
  }

  const messagingValues = [
    environment.MESSAGE_DELIVERY_URL,
    environment.MESSAGE_DELIVERY_TOKEN,
    environment.MESSAGE_WEBHOOK_SECRET
  ];
  if (messagingValues.some(Boolean) &&
      (!messagingValues.every(Boolean) || !(environment.MESSAGE_FROM_EMAIL || environment.MESSAGE_FROM_SMS))) {
    errors.push("- MESSAGE_DELIVERY_URL: messaging configuration requires URL, token, webhook secret, and at least one sender");
  }

  return errors;
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
  const productionErrors = [
    ...environmentMatrixErrors(environment),
    ...productionConfigurationErrors(environment)
  ];
  if (productionErrors.length > 0) {
    throw new Error([
      "Invalid backend environment configuration:",
      ...productionErrors,
      buildEnvironmentSourceMessage(source)
    ].join("\n"));
  }
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
    KAPCHI_ENVIRONMENT: resolvedKapchiEnvironment(environment),
    DATABASE_SSL_MODE:
      environment.DATABASE_SSL_MODE ??
      (environment.NODE_ENV === "production" ? "require" : "disable")
  };
}

const environment = validateEnvironment(process.env, environmentSource);

export const config = Object.freeze({
  app: {
    allowedOrigins: splitList(environment.CORS_ALLOWED_ORIGINS),
    host: environment.HOST,
    logLevel: environment.LOG_LEVEL,
    nodeEnv: environment.NODE_ENV,
    port: environment.PORT,
    environment: environment.KAPCHI_ENVIRONMENT,
    releaseEnvironmentIdentity: environment.RELEASE_ENVIRONMENT_IDENTITY_MARKER
      ? createHash("sha256")
          .update(`kapchi-deployment-identity:v1:${environment.RELEASE_ENVIRONMENT_IDENTITY_MARKER}`)
          .digest("hex")
      : "unconfigured",
    releaseDeploymentId: environment.RELEASE_DEPLOYMENT_ID ?? environment.VERCEL_DEPLOYMENT_ID ?? "development",
    releaseScenarioRegistryVersion: environment.RELEASE_SCENARIO_REGISTRY_VERSION ?? "unconfigured",
    releaseSha: environment.RELEASE_SHA ?? environment.VERCEL_GIT_COMMIT_SHA ?? "development"
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
    uploadCallbackSecret: environment.ASSET_UPLOAD_CALLBACK_SECRET,
    uploadCallbackKeys: {
      current: environment.ASSET_UPLOAD_CALLBACK_SECRET_CURRENT && environment.ASSET_UPLOAD_CALLBACK_KEY_ID_CURRENT
        ? { id: environment.ASSET_UPLOAD_CALLBACK_KEY_ID_CURRENT, secret: environment.ASSET_UPLOAD_CALLBACK_SECRET_CURRENT }
        : undefined,
      previous: environment.ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS && environment.ASSET_UPLOAD_CALLBACK_KEY_ID_PREVIOUS && environment.ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS_EXPIRES_AT
        ? { expiresAt: environment.ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS_EXPIRES_AT, id: environment.ASSET_UPLOAD_CALLBACK_KEY_ID_PREVIOUS, secret: environment.ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS }
        : undefined
    }
  },
  auth: {
    clerk: {
      jwksUrl: environment.CLERK_JWKS_URL,
      jwtIssuer: environment.CLERK_JWT_ISSUER,
      jwtAudience: environment.CLERK_JWT_AUDIENCE,
      authorizedParties: splitList(environment.CLERK_AUTHORIZED_PARTIES ?? environment.CORS_ALLOWED_ORIGINS),
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
  operations: {
    cronSecret: environment.CRON_SECRET
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
