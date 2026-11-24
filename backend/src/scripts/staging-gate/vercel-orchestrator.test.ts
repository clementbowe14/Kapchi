import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { AliasControlLedger, AliasIntent, ProjectRole, VercelAlias, VercelDeployment } from "./vercel-types.js";
import type { VercelClient } from "./vercel-client.js";
import { loadVercelGateConfig, VercelStagingOrchestrator, type VercelGateConfig } from "./vercel-orchestrator.js";

const sha = "a".repeat(40);
const oldSha = "b".repeat(40);
const identity = "c".repeat(64);

function config(): VercelGateConfig {
  return {
    aliases: { api: "api.staging.kapchi.test", storefront: "web.staging.kapchi.test" },
    bypassSecret: "bypass-value",
    expectedRepository: { fullName: "clementbowe14/Kapchi", id: "123" },
    identity: { production: "d".repeat(64), staging: identity },
    productionHosts: { api: "api.kapchi.test", storefront: "kapchi.test" },
    projects: { api: "prj_api", storefront: "prj_store" },
    registryVersion: "3",
    siteDomain: "staging.kapchi.test",
    teamId: "team_1",
    workflowSha: "e".repeat(40),
  };
}

function deployment(role: ProjectRole, id: string, releaseSha: string, createdAt: number): VercelDeployment {
  return {
    createdAt,
    id,
    projectId: role === "api" ? "prj_api" : "prj_store",
    readyAt: createdAt + 1,
    readyState: "READY",
    ref: "staging",
    sha: releaseSha,
    target: "preview",
    url: `${id}.vercel.app`,
  };
}

class MemoryLedger implements AliasControlLedger {
  intents = new Map<string, AliasIntent>();
  async createAliasIntent(intent: AliasIntent) { this.intents.set(intent.id, structuredClone(intent)); }
  async getAliasIntent(id: string) { return this.intents.get(id) ?? null; }
  async listUnfinishedAliasIntents() { return [...this.intents.values()].filter((intent) => !intent.completedAt && !intent.restoredAt); }
  async markAliasAssigned(id: string, role: ProjectRole, at: string) {
    const intent = this.intents.get(id)!;
    if (role === "api") intent.apiAssignedAt = at; else intent.storefrontAssignedAt = at;
  }
  async completeAliasIntent(id: string) { this.intents.get(id)!.completedAt = new Date(1_000).toISOString(); }
  async markAliasRestored(id: string, at: string) { this.intents.get(id)!.restoredAt = at; }
}

function harness() {
  const old = { api: deployment("api", "dpl_old_api", oldSha, 10), storefront: deployment("storefront", "dpl_old_store", oldSha, 10) };
  const fresh = { api: deployment("api", "dpl_new_api", sha, 1_100), storefront: deployment("storefront", "dpl_new_store", sha, 1_100) };
  const all = new Map([...Object.values(old), ...Object.values(fresh)].map((item) => [item.id, item]));
  const aliases: Record<ProjectRole, VercelAlias> = {
    api: { alias: "api.staging.kapchi.test", deploymentId: old.api.id, projectId: "prj_api" },
    storefront: { alias: "web.staging.kapchi.test", deploymentId: old.storefront.id, projectId: "prj_store" },
  };
  let postSnapshot = false;
  const release = (item: VercelDeployment) => ({
    environment: "staging", environmentIdentity: identity, registryVersion: "3",
    releaseDeploymentId: item.id, releaseSha: item.sha,
  });
  const roleForProject = (projectId: string): ProjectRole => projectId === "prj_api" ? "api" : "storefront";
  const fake = {
    assignAlias: vi.fn(async (deploymentId: string, alias: string) => {
      const role: ProjectRole = alias.startsWith("api.") ? "api" : "storefront";
      aliases[role] = { alias, deploymentId, projectId: role === "api" ? "prj_api" : "prj_store" };
    }),
    getAlias: vi.fn(async (alias: string) => structuredClone(alias.startsWith("api.") ? aliases.api : aliases.storefront)),
    getDeployment: vi.fn(async (id: string) => structuredClone(all.get(id)!)),
    getProject: vi.fn(async (id: string) => ({
      id, name: id, productionBranch: "production", protectionEnabled: id === "prj_store",
      repository: { name: "Kapchi", owner: "clementbowe14", repoId: "123", type: "github" },
    })),
    listDeployments: vi.fn(async (projectId: string) => {
      const role = roleForProject(projectId);
      return postSnapshot ? [fresh[role], old[role]] : [old[role]];
    }),
    listProjectDomains: vi.fn(async (id: string) => [id === "prj_api" ? "api.kapchi.test" : "kapchi.test"]),
    listProjectEnvironment: vi.fn(async () => [
      { gitBranch: "staging", key: "KAPCHI_ENVIRONMENT", targets: ["preview"] },
      { gitBranch: "staging", key: "RELEASE_ENVIRONMENT_IDENTITY_MARKER", targets: ["preview"] },
      { gitBranch: "staging", key: "RELEASE_SCENARIO_REGISTRY_VERSION", targets: ["preview"] },
    ]),
    probeJson: vi.fn(async (originValue: string, path: string) => {
      if (path === "/orders/me") return { body: { error: "unauthorized" }, status: 401 };
      const host = new URL(originValue).hostname;
      const item = host === aliases.api.alias ? all.get(aliases.api.deploymentId)!
        : host === aliases.storefront.alias ? all.get(aliases.storefront.deploymentId)!
        : [...all.values()].find((candidate) => candidate.url === host)!;
      return { body: release(item), status: 200 };
    }),
  };
  return { aliases, client: fake as unknown as VercelClient, fresh, ledger: new MemoryLedger(), old, setPostSnapshot: () => { postSnapshot = true; } };
}

describe("Vercel staging orchestration", () => {
  it("validates exact, separated staging configuration", () => {
    const environment = {
      GITHUB_REPOSITORY: "clementbowe14/Kapchi", GITHUB_REPOSITORY_ID: "123", TRUSTED_WORKFLOW_SHA: "e".repeat(40),
      PRODUCTION_API_ORIGIN: "https://api.kapchi.test", PRODUCTION_DEPLOYMENT_IDENTITY_HASH: "d".repeat(64),
      PRODUCTION_STOREFRONT_ORIGIN: "https://kapchi.test", STAGING_API_ALIAS: "https://api.staging.kapchi.test",
      STAGING_DEPLOYMENT_IDENTITY_HASH: identity, STAGING_SITE_DOMAIN: "staging.kapchi.test",
      STAGING_STOREFRONT_ALIAS: "https://web.staging.kapchi.test", STAGING_VERCEL_API_PROJECT_ID: "prj_api",
      STAGING_VERCEL_PROTECTION_BYPASS_SECRET: "bypass", STAGING_VERCEL_STOREFRONT_PROJECT_ID: "prj_store",
      STAGING_VERCEL_TEAM_ID: "team_1",
    };
    expect(loadVercelGateConfig(environment, "3")).toMatchObject({ aliases: config().aliases, registryVersion: "3" });
    expect(() => loadVercelGateConfig({ ...environment, PRODUCTION_API_ORIGIN: environment.STAGING_API_ALIAS }, "3"))
      .toThrow("must not match production");
  });

  it("selects only post-snapshot deployments, switches aliases, and emits a manifest", async () => {
    const state = harness();
    const orchestrator = new VercelStagingOrchestrator(state.client, state.ledger, config(), {
      now: () => 1_000,
      pollIntervalMs: 1,
      prepareDeadlineMs: 100,
      sleep: async () => undefined,
    });
    const snapshot = await orchestrator.snapshot("stg_release_12345678", sha);
    expect(snapshot.deployments).toEqual({ api: [state.old.api.id], storefront: [state.old.storefront.id] });
    state.setPostSnapshot();
    const directory = await mkdtemp(join(tmpdir(), "kapchi-vercel-orchestrator-"));
    const manifest = await orchestrator.prepare(snapshot, join(directory, "staging-deployment-manifest.json"));
    expect(manifest.deployments.api.id).toBe(state.fresh.api.id);
    expect(manifest.deployments.storefront.id).toBe(state.fresh.storefront.id);
    expect(state.aliases.api.deploymentId).toBe(state.fresh.api.id);
    expect(state.aliases.storefront.deploymentId).toBe(state.fresh.storefront.id);
    expect([...state.ledger.intents.values()][0]?.completedAt).not.toBeNull();
    expect(state.client.getDeployment).toHaveBeenCalledWith(state.fresh.api.id);
    expect(state.client.getDeployment).toHaveBeenCalledWith(state.fresh.storefront.id);
    await expect(orchestrator.verify(manifest)).resolves.toMatchObject({ candidateSha: sha });
  });

  it("restores only aliases still owned by an unfinished attempt", async () => {
    const state = harness();
    const intent: AliasIntent = {
      apiAssignedAt: new Date(1_000).toISOString(), attemptId: "stg_release_12345678", candidateSha: sha,
      completedAt: null, createdAt: new Date(1_000).toISOString(), id: `alias_${"f".repeat(32)}`,
      prior: {
        api: { alias: state.aliases.api.alias, deploymentId: state.old.api.id, projectId: "prj_api" },
        storefront: { alias: state.aliases.storefront.alias, deploymentId: state.old.storefront.id, projectId: "prj_store" },
      },
      projects: config().projects,
      requested: {
        api: { alias: state.aliases.api.alias, deploymentId: state.fresh.api.id, projectId: "prj_api" },
        storefront: { alias: state.aliases.storefront.alias, deploymentId: state.fresh.storefront.id, projectId: "prj_store" },
      },
      restoredAt: null, storefrontAssignedAt: new Date(1_000).toISOString(),
    };
    state.ledger.intents.set(intent.id, intent);
    state.aliases.api.deploymentId = state.fresh.api.id;
    state.aliases.storefront.deploymentId = state.fresh.storefront.id;
    const orchestrator = new VercelStagingOrchestrator(state.client, state.ledger, config(), { now: () => 2_000 });
    await expect(orchestrator.recover()).resolves.toEqual({ recovered: [intent.id] });
    expect(state.aliases.api.deploymentId).toBe(state.old.api.id);
    expect(state.aliases.storefront.deploymentId).toBe(state.old.storefront.id);
    expect(state.ledger.intents.get(intent.id)?.restoredAt).not.toBeNull();
  });

  it("fails closed when an alias was moved by another actor", async () => {
    const state = harness();
    const intent = {
      apiAssignedAt: null, attemptId: "stg_release_12345678", candidateSha: sha, completedAt: null,
      createdAt: new Date(1_000).toISOString(), id: `alias_${"f".repeat(32)}`,
      prior: structuredClone(state.aliases), projects: config().projects,
      requested: {
        api: { ...state.aliases.api, deploymentId: state.fresh.api.id },
        storefront: { ...state.aliases.storefront, deploymentId: state.fresh.storefront.id },
      }, restoredAt: null, storefrontAssignedAt: null,
    } satisfies AliasIntent;
    state.ledger.intents.set(intent.id, intent);
    state.aliases.api.deploymentId = "dpl_unknown";
    const orchestrator = new VercelStagingOrchestrator(state.client, state.ledger, config());
    await expect(orchestrator.recover()).rejects.toThrow("moved by another actor");
  });

  it("rejects a persisted recovery intent outside the configured aliases", async () => {
    const state = harness();
    const intent = {
      apiAssignedAt: null, attemptId: "stg_release_12345678", candidateSha: sha, completedAt: null,
      createdAt: new Date(1_000).toISOString(), id: `alias_${"f".repeat(32)}`,
      prior: {
        api: { ...state.aliases.api, alias: "api.kapchi.test" },
        storefront: structuredClone(state.aliases.storefront),
      },
      projects: config().projects,
      requested: {
        api: { ...state.aliases.api, alias: "api.kapchi.test", deploymentId: state.fresh.api.id },
        storefront: { ...state.aliases.storefront, deploymentId: state.fresh.storefront.id },
      },
      restoredAt: null, storefrontAssignedAt: null,
    } satisfies AliasIntent;
    state.ledger.intents.set(intent.id, intent);
    const orchestrator = new VercelStagingOrchestrator(state.client, state.ledger, config());

    await expect(orchestrator.recover()).rejects.toThrow("configured staging routing boundary");
    expect(state.client.assignAlias).not.toHaveBeenCalled();
  });

  it("rejects a tampered snapshot that omits its recoverable alias target", async () => {
    const state = harness();
    const orchestrator = new VercelStagingOrchestrator(state.client, state.ledger, config(), { now: () => 1_000 });
    const snapshot = await orchestrator.snapshot("stg_release_12345678", sha);
    snapshot.deployments.api = [];

    await expect(orchestrator.prepare(snapshot, "/tmp/unused-manifest.json"))
      .rejects.toThrow("configured projects and aliases");
  });

  it("rejects post-window manifest and alias drift", async () => {
    const state = harness();
    const orchestrator = new VercelStagingOrchestrator(state.client, state.ledger, config(), {
      now: () => 1_000,
      pollIntervalMs: 1,
      prepareDeadlineMs: 100,
      sleep: async () => undefined,
    });
    const snapshot = await orchestrator.snapshot("stg_release_12345678", sha);
    state.setPostSnapshot();
    const directory = await mkdtemp(join(tmpdir(), "kapchi-vercel-drift-"));
    const manifest = await orchestrator.prepare(snapshot, join(directory, "manifest.json"));
    const tampered = structuredClone(manifest);
    tampered.aliases.api.alias = "api.kapchi.test";
    await expect(orchestrator.verify(tampered)).rejects.toThrow("routing identity");

    state.aliases.api.deploymentId = state.old.api.id;
    await expect(orchestrator.verify(manifest)).rejects.toThrow("drifted after the test window");
  });

  it("times out when the branch update creates no new deployments", async () => {
    const state = harness();
    let now = 1_000;
    const orchestrator = new VercelStagingOrchestrator(state.client, state.ledger, config(), {
      now: () => now,
      pollIntervalMs: 5,
      prepareDeadlineMs: 10,
      sleep: async (milliseconds) => { now += milliseconds; },
    });
    const snapshot = await orchestrator.snapshot("stg_release_12345678", sha);

    await expect(orchestrator.prepare(snapshot, "/tmp/unused-manifest.json"))
      .rejects.toThrow("NO_NEW_DEPLOYMENT");
  });
});
