import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { config } from "../../config/index.js";
import { inspectMigrationState, MigrationError } from "../../database/migrate.js";

export type ReadinessDependency = "database" | "redis" | "migrations" | "privateAssetProvider";
export type ReadinessCode = "DATABASE_UNAVAILABLE" | "REDIS_UNAVAILABLE" | "MIGRATIONS_PENDING" | "MIGRATION_DRIFT" | "PRIVATE_ASSET_PROVIDER_UNCONFIGURED" | "READINESS_TIMEOUT";
type DependencyState = "ready" | "unready" | "unconfigured";
type ReadinessResult = {
  dependencies: Record<ReadinessDependency, DependencyState>;
  environment: string;
  environmentIdentity: string;
  failedDependencyCodes: ReadinessCode[];
  releaseDeploymentId: string;
  registryVersion: string;
  releaseSha: string;
  status: "ready" | "unready";
};
type HealthPluginOptions = {
  checks?: Partial<Record<ReadinessDependency, () => Promise<void>>>;
  cacheMs?: number;
  checkTimeoutMs?: number;
  overallTimeoutMs?: number;
};

function deadline<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("READINESS_TIMEOUT")), timeoutMs);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function createReadinessProbe(
  checks: Record<ReadinessDependency, () => Promise<void>>,
  options: { cacheMs: number; checkTimeoutMs: number; overallTimeoutMs: number },
) {
  let cached: { expiresAt: number; value: ReadinessResult } | undefined;
  let inFlight: Promise<ReadinessResult> | undefined;
  const dependencyWork = new Map<ReadinessDependency, Promise<void>>();

  const sharedDependencyCheck = (dependency: ReadinessDependency) => {
    const existing = dependencyWork.get(dependency);
    if (existing) return existing;
    const started = checks[dependency]().finally(() => {
      if (dependencyWork.get(dependency) === started) dependencyWork.delete(dependency);
    });
    dependencyWork.set(dependency, started);
    return started;
  };

  const execute = async (): Promise<ReadinessResult> => {
    const dependencies: ReadinessResult["dependencies"] = {
      database: "ready", redis: "ready", migrations: "ready", privateAssetProvider: "ready"
    };
    const failedDependencyCodes: ReadinessCode[] = [];
    const codeByDependency: Record<ReadinessDependency, ReadinessCode> = {
      database: "DATABASE_UNAVAILABLE",
      redis: "REDIS_UNAVAILABLE",
      migrations: "MIGRATION_DRIFT",
      privateAssetProvider: "PRIVATE_ASSET_PROVIDER_UNCONFIGURED"
    };

    await Promise.all((Object.keys(checks) as ReadinessDependency[]).map(async (dependency) => {
      try {
        await deadline(sharedDependencyCheck(dependency), options.checkTimeoutMs);
      } catch (error) {
        if (dependency === "privateAssetProvider") dependencies[dependency] = "unconfigured";
        else dependencies[dependency] = "unready";
        if (error instanceof MigrationError && error.errorCode === "MIGRATIONS_PENDING") {
          failedDependencyCodes.push("MIGRATIONS_PENDING");
        } else if (error instanceof Error && error.message === "READINESS_TIMEOUT") {
          failedDependencyCodes.push("READINESS_TIMEOUT");
        } else {
          failedDependencyCodes.push(codeByDependency[dependency]);
        }
      }
    }));

    return {
      dependencies,
      environment: config.app.environment,
      environmentIdentity: config.app.releaseEnvironmentIdentity,
      failedDependencyCodes: [...new Set(failedDependencyCodes)].sort(),
      releaseDeploymentId: config.app.releaseDeploymentId,
      registryVersion: config.app.releaseScenarioRegistryVersion,
      releaseSha: config.app.releaseSha,
      status: failedDependencyCodes.length === 0 ? "ready" : "unready"
    };
  };

  return async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (inFlight) return inFlight;
    inFlight = deadline(execute(), options.overallTimeoutMs)
      .catch((): ReadinessResult => ({
        dependencies: { database: "unready", redis: "unready", migrations: "unready", privateAssetProvider: "unready" },
        environment: config.app.environment,
        environmentIdentity: config.app.releaseEnvironmentIdentity,
        failedDependencyCodes: ["READINESS_TIMEOUT"],
        releaseDeploymentId: config.app.releaseDeploymentId,
        registryVersion: config.app.releaseScenarioRegistryVersion,
        releaseSha: config.app.releaseSha,
        status: "unready"
      }))
      .then((value) => {
        cached = { expiresAt: Date.now() + options.cacheMs, value };
        return value;
      })
      .finally(() => { inFlight = undefined; });
    return inFlight;
  };
}

const healthPlugin: FastifyPluginAsync<HealthPluginOptions> = async (fastify, options) => {
  const checks: Record<ReadinessDependency, () => Promise<void>> = {
    database: options.checks?.database ?? (async () => { await fastify.pg.query("select 1"); }),
    redis: options.checks?.redis ?? (async () => { await fastify.redis.ping(); }),
    migrations: options.checks?.migrations ?? (async () => {
      const state = await inspectMigrationState(fastify.pg, { requireChecksums: config.app.nodeEnv === "production" });
      if (state.pending.length > 0) throw new MigrationError("MIGRATIONS_PENDING", 12, state.pending[0]?.id);
    }),
    privateAssetProvider: options.checks?.privateAssetProvider ?? (async () => {
      if (!config.assets.privateReads.vercel.token) throw new Error("UNCONFIGURED");
    })
  };
  const probe = createReadinessProbe(checks, {
    cacheMs: options.cacheMs ?? 2_000,
    checkTimeoutMs: options.checkTimeoutMs ?? 500,
    overallTimeoutMs: options.overallTimeoutMs ?? 1_500
  });

  fastify.get("/health", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return {
      environment: config.app.environment,
      environmentIdentity: config.app.releaseEnvironmentIdentity,
      releaseDeploymentId: config.app.releaseDeploymentId,
      registryVersion: config.app.releaseScenarioRegistryVersion,
      releaseSha: config.app.releaseSha,
      service: "kapchi-backend",
      status: "ok"
    };
  });

  fastify.get("/ready", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const result = await probe();
    if (result.status === "unready") {
      fastify.log.warn({ event: "readiness.failed", failedDependencyCodes: result.failedDependencyCodes }, "Readiness check failed");
      return reply.code(503).send(result);
    }
    return result;
  });
};

export default fp(healthPlugin, { name: "health-plugin" });
