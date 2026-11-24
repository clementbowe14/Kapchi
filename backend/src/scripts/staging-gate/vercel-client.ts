import type {
  ReleaseIdentity,
  VercelAlias,
  VercelDeployment,
  VercelEnvironmentVariable,
  VercelProject,
} from "./vercel-types.js";

const MAX_PROBE_BYTES = 64 * 1024;
const DEPLOYMENT_STATES = new Set(["BUILDING", "CANCELED", "ERROR", "INITIALIZING", "QUEUED", "READY"]);

export class VercelOperationError extends Error {
  constructor(
    readonly code: string,
    readonly operation: string,
    readonly status?: number,
    readonly attempts = 1,
    readonly retryAfterMs?: number,
  ) {
    super(`${operation} failed (${code})`);
    this.name = "VercelOperationError";
  }
}

type ClientDependencies = {
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type RequestOptions = {
  allowEventualNotFound?: boolean;
  attempts?: number;
  body?: unknown;
  method?: "GET" | "POST";
  operation: string;
};

function object(value: unknown, operation: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VercelOperationError("MALFORMED_RESPONSE", operation);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, operation: string) {
  if (typeof value !== "string" || !value) {
    throw new VercelOperationError(`MISSING_${field.toUpperCase()}`, operation);
  }
  return value;
}

function parseRetryAfter(value: string | null, now: number) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function deploymentFrom(value: unknown, operation: string): VercelDeployment {
  const row = object(value, operation);
  const project = row.project == null ? undefined : object(row.project, operation);
  const id = text(row.uid ?? row.id, "deployment_id", operation);
  const projectId = text(row.projectId ?? project?.id, "project_id", operation);
  const url = text(row.url, "url", operation).replace(/^https?:\/\//, "");
  const state = text(row.readyState ?? row.state, "ready_state", operation).toUpperCase();
  if (!DEPLOYMENT_STATES.has(state)) throw new VercelOperationError("INVALID_READY_STATE", operation);
  const target = row.target == null
    ? (row.environment == null || String(row.environment).toLowerCase() === "preview" ? "preview" : null)
    : text(row.target, "target", operation).toLowerCase();
  if (target !== null && target !== "preview" && target !== "production") {
    throw new VercelOperationError("INVALID_TARGET", operation);
  }
  const meta = object(row.meta ?? {}, operation);
  const createdAt = Number(row.createdAt ?? row.created);
  if (!Number.isFinite(createdAt)) throw new VercelOperationError("INVALID_CREATED_AT", operation);
  const readyAt = row.readyAt == null ? undefined : Number(row.readyAt);
  return {
    createdAt,
    id,
    projectId,
    readyAt: Number.isFinite(readyAt) ? readyAt : undefined,
    readyState: state as VercelDeployment["readyState"],
    ref: typeof meta.githubCommitRef === "string" ? meta.githubCommitRef : undefined,
    sha: typeof meta.githubCommitSha === "string" ? meta.githubCommitSha : undefined,
    target,
    url,
  };
}

function aliasFrom(value: unknown, operation: string): VercelAlias {
  const row = object(value, operation);
  const deployment = row.deployment == null ? undefined : object(row.deployment, operation);
  const project = row.project == null ? undefined : object(row.project, operation);
  return {
    alias: text(row.alias, "alias", operation).replace(/^https?:\/\//, ""),
    deploymentId: text(row.deploymentId ?? deployment?.id, "deployment_id", operation),
    projectId: text(row.projectId ?? project?.id, "project_id", operation),
  };
}

export class VercelClient {
  private abortGeneration = 0;
  private readonly activeControllers = new Set<AbortController>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly token: string,
    private readonly teamId: string,
    dependencies: ClientDependencies = {},
  ) {
    if (!token || !teamId) throw new Error("Vercel token and team ID are required.");
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private async request(path: string, options: RequestOptions) {
    const maximumAttempts = options.attempts ?? 5;
    const deadline = this.now() + 60_000;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const abortGeneration = this.abortGeneration;
      const controller = new AbortController();
      this.activeControllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let response: Response | undefined;
      try {
        const url = new URL(path, "https://api.vercel.com");
        url.searchParams.set("teamId", this.teamId);
        response = await this.fetchImpl(url, {
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          },
          method: options.method ?? "GET",
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        this.activeControllers.delete(controller);
        if (abortGeneration !== this.abortGeneration) {
          throw new VercelOperationError("CANCELLED", options.operation, undefined, attempt);
        }
        if (attempt === maximumAttempts || this.now() >= deadline) {
          throw new VercelOperationError(error instanceof DOMException && error.name === "AbortError" ? "TIMEOUT" : "NETWORK", options.operation, undefined, attempt);
        }
        await this.sleep(Math.min(4_000, 250 * 2 ** (attempt - 1)) + Math.floor(this.random() * 100));
        continue;
      }
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
      if (response.ok) {
        try {
          return await response.json() as unknown;
        } catch {
          throw new VercelOperationError("MALFORMED_RESPONSE", options.operation, response.status, attempt);
        }
      }
      const retryable = [408, 429].includes(response.status) || response.status >= 500 ||
        (options.allowEventualNotFound === true && response.status === 404);
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.now()) ?? undefined;
      if (!retryable || attempt === maximumAttempts) {
        throw new VercelOperationError(`HTTP_${response.status}`, options.operation, response.status, attempt, retryAfter);
      }
      const delay = retryAfter ?? Math.min(4_000, 250 * 2 ** (attempt - 1)) + Math.floor(this.random() * 100);
      if (this.now() + delay > deadline) {
        throw new VercelOperationError("RETRY_BUDGET_EXCEEDED", options.operation, response.status, attempt);
      }
      await this.sleep(delay);
    }
    throw new VercelOperationError("RETRY_EXHAUSTED", options.operation);
  }

  abortPending() {
    this.abortGeneration += 1;
    for (const controller of this.activeControllers) controller.abort();
    this.activeControllers.clear();
  }

  async getProject(projectId: string): Promise<VercelProject> {
    const operation = "project.get";
    const row = object(await this.request(`/v9/projects/${encodeURIComponent(projectId)}`, { operation }), operation);
    const link = row.link ? object(row.link, operation) : undefined;
    const security = row.security ? object(row.security, operation) : {};
    return {
      id: text(row.id, "project_id", operation),
      name: text(row.name, "project_name", operation),
      productionBranch: text(link?.productionBranch ?? row.productionBranch, "production_branch", operation),
      protectionEnabled: Boolean(row.passwordProtection || row.ssoProtection || security.deploymentProtection),
      repository: link ? {
        name: typeof link.repo === "string" ? link.repo : undefined,
        owner: typeof link.org === "string" ? link.org : undefined,
        repoId: link.repoId == null ? undefined : String(link.repoId),
        type: typeof link.type === "string" ? link.type : undefined,
      } : undefined,
    };
  }

  async listProjectEnvironment(projectId: string): Promise<VercelEnvironmentVariable[]> {
    const operation = "project.environment.list";
    const body = object(await this.request(`/v9/projects/${encodeURIComponent(projectId)}/env`, { operation }), operation);
    const rows = Array.isArray(body.envs) ? body.envs : [];
    return rows.map((value) => {
      const row = object(value, operation);
      const targets = Array.isArray(row.target) ? row.target.filter((item): item is string => typeof item === "string") : [];
      return {
        gitBranch: typeof row.gitBranch === "string" ? row.gitBranch : undefined,
        key: text(row.key, "environment_key", operation),
        targets,
      };
    });
  }

  async listProjectDomains(projectId: string): Promise<string[]> {
    const operation = "project.domains.list";
    const body = object(await this.request(`/v9/projects/${encodeURIComponent(projectId)}/domains`, { operation }), operation);
    if (!Array.isArray(body.domains)) throw new VercelOperationError("MALFORMED_RESPONSE", operation);
    return body.domains.map((value) => text(object(value, operation).name, "domain", operation));
  }

  async listDeployments(projectId: string): Promise<VercelDeployment[]> {
    const operation = "deployment.list";
    const body = object(await this.request(`/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=100`, { operation }), operation);
    if (!Array.isArray(body.deployments)) throw new VercelOperationError("MALFORMED_RESPONSE", operation);
    return body.deployments.map((value) => deploymentFrom(value, operation));
  }

  async getDeployment(deploymentId: string): Promise<VercelDeployment> {
    const operation = "deployment.get";
    return deploymentFrom(await this.request(`/v13/deployments/${encodeURIComponent(deploymentId)}`, { operation }), operation);
  }

  async getAlias(host: string, eventual = false): Promise<VercelAlias> {
    const operation = "alias.get";
    return aliasFrom(await this.request(`/v4/aliases/${encodeURIComponent(host)}`, {
      allowEventualNotFound: eventual,
      operation,
    }), operation);
  }

  async assignAlias(deploymentId: string, alias: string): Promise<void> {
    const operation = "alias.assign";
    const baseline = await this.getAlias(alias);
    const deadline = this.now() + 60_000;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let mutationError: VercelOperationError | undefined;
      try {
        await this.request(`/v2/deployments/${encodeURIComponent(deploymentId)}/aliases`, {
          attempts: 1,
          body: { alias },
          method: "POST",
          operation,
        });
      } catch (error) {
        if (!(error instanceof VercelOperationError)) throw error;
        const status = error.status;
        const retryable = status == null || [408, 409, 429].includes(status) || status >= 500;
        if (!retryable || error.code === "CANCELLED") throw error;
        mutationError = error;
      }
      const current = await this.getAlias(alias, true);
      if (current.deploymentId === deploymentId) return;
      if (current.deploymentId !== baseline.deploymentId) {
        throw new VercelOperationError("ALIAS_DRIFT", operation);
      }
      if (attempt === 3) throw new VercelOperationError("MUTATION_RETRY_EXHAUSTED", operation);
      const delay = mutationError?.retryAfterMs ??
        Math.min(4_000, 250 * 2 ** (attempt - 1)) + Math.floor(this.random() * 100);
      if (this.now() + delay > deadline) {
        throw new VercelOperationError("MUTATION_RETRY_BUDGET_EXCEEDED", operation, mutationError?.status, attempt);
      }
      await this.sleep(delay);
    }
  }

  private async probeJsonOnce(
    origin: string,
    path: string,
    options: { bypassSecret?: string; expectedStatuses?: number[] },
  ): Promise<{ body: Record<string, unknown>; status: number }> {
    const abortGeneration = this.abortGeneration;
    const url = new URL(path, origin);
    if (url.origin !== origin || url.protocol !== "https:") throw new Error("Probe origin or path is unsafe.");
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        cache: "no-store",
        headers: options.bypassSecret ? { "x-vercel-protection-bypass": options.bypassSecret } : undefined,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (abortGeneration !== this.abortGeneration) throw new VercelOperationError("CANCELLED", "probe");
      throw new VercelOperationError(
        error instanceof DOMException && error.name === "AbortError" ? "TIMEOUT" : "NETWORK",
        "probe",
      );
    } finally {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
    }
    if (response.status >= 300 && response.status < 400) throw new VercelOperationError("PROBE_REDIRECT", "probe", response.status);
    if (!(options.expectedStatuses ?? [200]).includes(response.status)) {
      throw new VercelOperationError(
        "PROBE_STATUS",
        "probe",
        response.status,
        1,
        parseRetryAfter(response.headers.get("retry-after"), this.now()) ?? undefined,
      );
    }
    const cacheControl = response.headers.get("cache-control") ?? "";
    if (response.status === 200 && !cacheControl.toLowerCase().includes("no-store")) {
      throw new VercelOperationError("PROBE_CACHEABLE", "probe", response.status);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) throw new VercelOperationError("PROBE_CONTENT_TYPE", "probe", response.status);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_PROBE_BYTES) {
      throw new VercelOperationError("PROBE_TOO_LARGE", "probe", response.status);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new VercelOperationError("PROBE_EMPTY_BODY", "probe", response.status);
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_PROBE_BYTES) {
        await reader.cancel();
        throw new VercelOperationError("PROBE_TOO_LARGE", "probe", response.status);
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return { body: object(JSON.parse(new TextDecoder().decode(bytes)), "probe"), status: response.status };
    } catch (error) {
      if (error instanceof VercelOperationError) throw error;
      throw new VercelOperationError("PROBE_MALFORMED_JSON", "probe", response.status);
    }
  }

  async probeJson(
    origin: string,
    path: string,
    options: { bypassSecret?: string; expectedStatuses?: number[] } = {},
  ): Promise<{ body: Record<string, unknown>; status: number }> {
    const deadline = this.now() + 60_000;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        return await this.probeJsonOnce(origin, path, options);
      } catch (error) {
        if (!(error instanceof VercelOperationError)) throw error;
        const transient = ["NETWORK", "TIMEOUT"].includes(error.code) ||
          error.status === 408 || error.status === 429 || (error.status != null && error.status >= 500);
        if (!transient || error.code === "CANCELLED" || attempt === 5) throw error;
        const delay = error.retryAfterMs ??
          Math.min(4_000, 250 * 2 ** (attempt - 1)) + Math.floor(this.random() * 100);
        if (this.now() + delay > deadline) {
          throw new VercelOperationError("PROBE_RETRY_BUDGET_EXCEEDED", "probe", error.status, attempt);
        }
        await this.sleep(delay);
      }
    }
    throw new VercelOperationError("PROBE_RETRY_EXHAUSTED", "probe");
  }
}

export function parseReleaseIdentity(value: Record<string, unknown>): ReleaseIdentity {
  const operation = "release.identity";
  return {
    environment: text(value.environment, "environment", operation),
    environmentIdentity: text(value.environmentIdentity, "environment_identity", operation),
    registryVersion: text(value.registryVersion, "registry_version", operation),
    releaseDeploymentId: text(value.releaseDeploymentId, "release_deployment_id", operation),
    releaseSha: text(value.releaseSha, "release_sha", operation),
  };
}
