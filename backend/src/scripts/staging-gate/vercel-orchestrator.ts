import { createHash } from "node:crypto";
import type {
  AliasControlLedger,
  AliasIntent,
  DeploymentSnapshot,
  ProjectRole,
  ReleaseIdentity,
  StagingDeploymentManifest,
  VercelAlias,
  VercelDeployment,
  VerifiedDeployment,
} from "./vercel-types.js";
import { parseReleaseIdentity, VercelClient } from "./vercel-client.js";
import { writeAtomicJson } from "./vercel-evidence.js";

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const ATTEMPT = /^stg_[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;
const REQUIRED_IDENTITY_KEYS = [
  "KAPCHI_ENVIRONMENT",
  "RELEASE_ENVIRONMENT_IDENTITY_MARKER",
  "RELEASE_SCENARIO_REGISTRY_VERSION",
] as const;

export type VercelGateConfig = {
  aliases: Record<ProjectRole, string>;
  bypassSecret: string;
  expectedRepository: { fullName: string; id?: string };
  identity: { production: string; staging: string };
  productionHosts: Record<ProjectRole, string>;
  projects: Record<ProjectRole, string>;
  registryVersion: string;
  siteDomain: string;
  teamId: string;
  workflowSha: string;
};

type OrchestratorDependencies = {
  now?: () => number;
  pollIntervalMs?: number;
  prepareDeadlineMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function exactHttpsOrigin(value: string, name: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.port ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an exact HTTPS origin without credentials, port, path, query, or fragment.`);
  }
  return url.hostname;
}

export function loadVercelGateConfig(
  environment: NodeJS.ProcessEnv,
  registryVersion: string,
): VercelGateConfig {
  const storefrontAlias = exactHttpsOrigin(required(environment, "STAGING_STOREFRONT_ALIAS"), "STAGING_STOREFRONT_ALIAS");
  const apiAlias = exactHttpsOrigin(required(environment, "STAGING_API_ALIAS"), "STAGING_API_ALIAS");
  const siteDomain = required(environment, "STAGING_SITE_DOMAIN").toLowerCase();
  const productionStorefront = exactHttpsOrigin(required(environment, "PRODUCTION_STOREFRONT_ORIGIN"), "PRODUCTION_STOREFRONT_ORIGIN");
  const productionApi = exactHttpsOrigin(required(environment, "PRODUCTION_API_ORIGIN"), "PRODUCTION_API_ORIGIN");
  const stagingIdentity = required(environment, "STAGING_DEPLOYMENT_IDENTITY_HASH");
  const productionIdentity = required(environment, "PRODUCTION_DEPLOYMENT_IDENTITY_HASH");
  if (!HASH.test(stagingIdentity) || !HASH.test(productionIdentity) || stagingIdentity === productionIdentity) {
    throw new Error("Staging and production deployment identity hashes must be distinct lowercase SHA-256 values.");
  }
  const siteLabels = siteDomain.split(".").length;
  const sibling = (host: string) => host.endsWith(`.${siteDomain}`) && host.split(".").length === siteLabels + 1;
  if (!sibling(storefrontAlias) || !sibling(apiAlias) || storefrontAlias === apiAlias) {
    throw new Error("Staging aliases must be distinct same-site siblings.");
  }
  const allHosts = [storefrontAlias, apiAlias, productionStorefront, productionApi];
  if (new Set(allHosts).size !== allHosts.length) throw new Error("Staging aliases must not match production hosts.");
  const repository = required(environment, "GITHUB_REPOSITORY");
  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY must be owner/name.");
  const workflowSha = required(environment, "TRUSTED_WORKFLOW_SHA");
  if (!SHA.test(workflowSha)) throw new Error("TRUSTED_WORKFLOW_SHA must be a full lowercase SHA.");
  return {
    aliases: { api: apiAlias, storefront: storefrontAlias },
    bypassSecret: required(environment, "STAGING_VERCEL_PROTECTION_BYPASS_SECRET"),
    expectedRepository: { fullName: repository, id: environment.GITHUB_REPOSITORY_ID?.trim() || undefined },
    identity: { production: productionIdentity, staging: stagingIdentity },
    productionHosts: { api: productionApi, storefront: productionStorefront },
    projects: {
      api: required(environment, "STAGING_VERCEL_API_PROJECT_ID"),
      storefront: required(environment, "STAGING_VERCEL_STOREFRONT_PROJECT_ID"),
    },
    registryVersion,
    siteDomain,
    teamId: required(environment, "STAGING_VERCEL_TEAM_ID"),
    workflowSha,
  };
}

function assertInvocation(attemptId: string, candidateSha: string) {
  if (!ATTEMPT.test(attemptId)) throw new Error("Attempt ID is invalid.");
  if (!SHA.test(candidateSha)) throw new Error("Candidate SHA must be a full lowercase SHA.");
}

function origin(host: string) {
  return `https://${host}`;
}

function sameAlias(actual: VercelAlias, expected: VercelAlias) {
  return actual.alias === expected.alias && actual.deploymentId === expected.deploymentId && actual.projectId === expected.projectId;
}

function sameAliasIntent(actual: AliasIntent, expected: AliasIntent) {
  return actual.id === expected.id && actual.attemptId === expected.attemptId &&
    actual.candidateSha === expected.candidateSha && actual.createdAt === expected.createdAt &&
    actual.completedAt === expected.completedAt && actual.restoredAt === expected.restoredAt &&
    actual.storefrontAssignedAt === expected.storefrontAssignedAt && actual.apiAssignedAt === expected.apiAssignedAt &&
    actual.projects.storefront === expected.projects.storefront && actual.projects.api === expected.projects.api &&
    sameAlias(actual.prior.storefront, expected.prior.storefront) &&
    sameAlias(actual.prior.api, expected.prior.api) &&
    sameAlias(actual.requested.storefront, expected.requested.storefront) &&
    sameAlias(actual.requested.api, expected.requested.api);
}

export class VercelStagingOrchestrator {
  private cancelled = false;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly prepareDeadlineMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly client: VercelClient,
    private readonly ledger: AliasControlLedger,
    private readonly config: VercelGateConfig,
    dependencies: OrchestratorDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.pollIntervalMs = dependencies.pollIntervalMs ?? 5_000;
    this.prepareDeadlineMs = dependencies.prepareDeadlineMs ?? 110 * 60 * 1_000;
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  cancel() {
    this.cancelled = true;
    this.client.abortPending();
  }

  private assertActive() {
    if (this.cancelled) throw new Error("Staging orchestration was cancelled.");
  }

  private async assertProject(role: ProjectRole) {
    const projectId = this.config.projects[role];
    const project = await this.client.getProject(projectId);
    if (project.id !== projectId || project.productionBranch !== "production") {
      throw new Error(`${role} project identity or production branch is invalid.`);
    }
    const [owner, name] = this.config.expectedRepository.fullName.split("/");
    if (project.repository?.owner !== owner || project.repository.name !== name ||
        (this.config.expectedRepository.id && project.repository.repoId !== this.config.expectedRepository.id) ||
        project.repository.type !== "github") {
      throw new Error(`${role} project is not linked to the expected GitHub repository.`);
    }
    if ((role === "storefront") !== project.protectionEnabled) {
      throw new Error(`${role} Vercel deployment-protection configuration is unsafe.`);
    }
    const variables = await this.client.listProjectEnvironment(projectId);
    for (const key of REQUIRED_IDENTITY_KEYS) {
      const matches = variables.filter((variable) => variable.key === key);
      if (matches.length !== 1 || matches[0]?.gitBranch !== "staging" ||
          matches[0].targets.length !== 1 || matches[0].targets[0] !== "preview") {
        throw new Error(`${role} ${key} must have exactly one staging-branch Preview scope.`);
      }
    }
    const domains = await this.client.listProjectDomains(projectId);
    if (!domains.includes(this.config.productionHosts[role])) {
      throw new Error(`${role} production denylist host is not registered to the expected project.`);
    }
    return project;
  }

  private assertDeployment(role: ProjectRole, deployment: VercelDeployment, candidateSha?: string) {
    if (deployment.projectId !== this.config.projects[role] || deployment.target !== "preview" ||
        deployment.ref !== "staging" || deployment.readyState !== "READY" ||
        (candidateSha && deployment.sha !== candidateSha) ||
        !deployment.url.endsWith(".vercel.app") ||
        Object.values(this.config.productionHosts).includes(deployment.url) ||
        Object.values(this.config.aliases).includes(deployment.url)) {
      throw new Error(`${role} deployment failed immutable Preview identity validation.`);
    }
  }

  private assertRelease(deployment: VercelDeployment, release: ReleaseIdentity) {
    if (release.environment !== "staging" || release.environmentIdentity !== this.config.identity.staging ||
        release.environmentIdentity === this.config.identity.production ||
        release.registryVersion !== this.config.registryVersion ||
        release.releaseDeploymentId !== deployment.id || release.releaseSha !== deployment.sha) {
      throw new Error("Runtime release identity does not match the expected staging deployment.");
    }
  }

  private assertAliasIntent(intent: AliasIntent) {
    assertInvocation(intent.attemptId, intent.candidateSha);
    if (!/^alias_[0-9a-f]{32}$/.test(intent.id)) throw new Error("Alias intent ID is invalid.");
    for (const role of ["storefront", "api"] as const) {
      if (intent.projects[role] !== this.config.projects[role] ||
          intent.prior[role].alias !== this.config.aliases[role] ||
          intent.requested[role].alias !== this.config.aliases[role] ||
          intent.prior[role].projectId !== this.config.projects[role] ||
          intent.requested[role].projectId !== this.config.projects[role] ||
          !intent.prior[role].deploymentId || !intent.requested[role].deploymentId ||
          intent.prior[role].deploymentId === intent.requested[role].deploymentId) {
        throw new Error("Alias intent does not match the configured staging routing boundary.");
      }
    }
  }

  private assertSnapshot(snapshot: DeploymentSnapshot) {
    assertInvocation(snapshot.attemptId, snapshot.candidateSha);
    const createdAt = Date.parse(snapshot.createdAt);
    if (snapshot.schemaVersion !== 1 || !Number.isFinite(createdAt) || createdAt > this.now() + 60_000) {
      throw new Error("Deployment snapshot metadata is invalid.");
    }
    for (const role of ["storefront", "api"] as const) {
      if (snapshot.projects[role].id !== this.config.projects[role] ||
          snapshot.aliases[role].alias !== this.config.aliases[role] ||
          snapshot.aliases[role].projectId !== this.config.projects[role] ||
          !snapshot.deployments[role].includes(snapshot.aliases[role].deploymentId) ||
          new Set(snapshot.deployments[role]).size !== snapshot.deployments[role].length) {
        throw new Error("Deployment snapshot does not match the configured projects and aliases.");
      }
    }
  }

  private assertManifest(manifest: StagingDeploymentManifest) {
    assertInvocation(manifest.attemptId, manifest.candidateSha);
    if (manifest.schemaVersion !== 1 || manifest.sourceRef !== "staging" ||
        manifest.teamId !== this.config.teamId ||
        manifest.repository !== this.config.expectedRepository.fullName ||
        !SHA.test(manifest.workflowSha) ||
        manifest.candidateSha !== manifest.deployments.api.sha ||
        manifest.candidateSha !== manifest.deployments.storefront.sha ||
        manifest.registryVersion !== this.config.registryVersion) {
      throw new Error("Deployment manifest identity is invalid.");
    }
    for (const role of ["storefront", "api"] as const) {
      if (manifest.aliases[role].alias !== this.config.aliases[role] ||
          manifest.aliases[role].newTarget !== manifest.deployments[role].id ||
          manifest.deployments[role].projectId !== this.config.projects[role]) {
        throw new Error("Deployment manifest routing identity is invalid.");
      }
    }
  }

  private async verifyDeployment(role: ProjectRole, deployment: VercelDeployment, candidateSha?: string): Promise<VerifiedDeployment> {
    this.assertDeployment(role, deployment, candidateSha);
    const deploymentOrigin = origin(deployment.url);
    const releaseResponse = role === "storefront"
      ? await this.client.probeJson(deploymentOrigin, "/api/release", { bypassSecret: this.config.bypassSecret })
      : await this.client.probeJson(deploymentOrigin, "/health");
    const release = parseReleaseIdentity(releaseResponse.body);
    this.assertRelease(deployment, release);
    if (role === "api") {
      const ready = parseReleaseIdentity((await this.client.probeJson(deploymentOrigin, "/ready")).body);
      this.assertRelease(deployment, ready);
      const denial = await this.client.probeJson(deploymentOrigin, "/orders/me", { expectedStatuses: [401, 403] });
      if (![401, 403].includes(denial.status)) throw new Error("Protected API route is exposed.");
    }
    return { ...deployment, release, verifiedAt: new Date(this.now()).toISOString() };
  }

  private async verifyAlias(role: ProjectRole, alias: VercelAlias, candidateSha?: string) {
    if (alias.alias !== this.config.aliases[role] || alias.projectId !== this.config.projects[role]) {
      throw new Error(`${role} alias ownership is invalid.`);
    }
    const deployment = await this.client.getDeployment(alias.deploymentId);
    const verified = await this.verifyDeployment(role, deployment, candidateSha);
    const releasePath = role === "storefront" ? "/api/release" : "/health";
    const response = await this.client.probeJson(origin(alias.alias), releasePath,
      role === "storefront" ? { bypassSecret: this.config.bypassSecret } : undefined);
    this.assertRelease(deployment, parseReleaseIdentity(response.body));
    return verified;
  }

  async recover(): Promise<{ recovered: string[] }> {
    const recovered: string[] = [];
    for (const intent of await this.ledger.listUnfinishedAliasIntents()) {
      this.assertAliasIntent(intent);
      for (const role of ["storefront", "api"] as const) {
        const current = await this.client.getAlias(intent.prior[role].alias);
        if (sameAlias(current, intent.prior[role])) continue;
        if (!sameAlias(current, intent.requested[role])) {
          throw new Error(`Alias ${role} moved by another actor; automatic recovery refused.`);
        }
        const priorDeployment = await this.client.getDeployment(intent.prior[role].deploymentId);
        await this.verifyDeployment(role, priorDeployment);
        await this.client.assignAlias(intent.prior[role].deploymentId, intent.prior[role].alias);
        const restored = await this.client.getAlias(intent.prior[role].alias, true);
        if (!sameAlias(restored, intent.prior[role])) throw new Error(`${role} alias recovery read-back failed.`);
      }
      await this.ledger.markAliasRestored(intent.id, new Date(this.now()).toISOString());
      recovered.push(intent.id);
    }
    return { recovered };
  }

  async snapshot(attemptId: string, candidateSha: string): Promise<DeploymentSnapshot> {
    assertInvocation(attemptId, candidateSha);
    await this.recover();
    const [storefrontProject, apiProject, storefrontDeployments, apiDeployments, storefrontAlias, apiAlias] = await Promise.all([
      this.assertProject("storefront"),
      this.assertProject("api"),
      this.client.listDeployments(this.config.projects.storefront),
      this.client.listDeployments(this.config.projects.api),
      this.client.getAlias(this.config.aliases.storefront),
      this.client.getAlias(this.config.aliases.api),
    ]);
    await this.verifyAlias("storefront", storefrontAlias);
    await this.verifyAlias("api", apiAlias);
    return {
      aliases: { api: apiAlias, storefront: storefrontAlias },
      attemptId,
      candidateSha,
      createdAt: new Date(this.now()).toISOString(),
      deployments: {
        api: [...new Set([...apiDeployments.map((deployment) => deployment.id), apiAlias.deploymentId])],
        storefront: [
          ...new Set([...storefrontDeployments.map((deployment) => deployment.id), storefrontAlias.deploymentId]),
        ],
      },
      projects: { api: apiProject, storefront: storefrontProject },
      schemaVersion: 1,
    };
  }

  private async discover(role: ProjectRole, snapshot: DeploymentSnapshot): Promise<VerifiedDeployment | null> {
    this.assertActive();
    const old = new Set(snapshot.deployments[role]);
    const candidates = (await this.client.listDeployments(this.config.projects[role]))
      .filter((deployment) => !old.has(deployment.id) && deployment.createdAt >= Date.parse(snapshot.createdAt) &&
        deployment.projectId === this.config.projects[role] && deployment.sha === snapshot.candidateSha &&
        deployment.ref === "staging" && deployment.target === "preview")
      .sort((left, right) => right.createdAt - left.createdAt);
    for (const candidate of candidates.filter((deployment) => deployment.readyState === "READY")) {
      return this.verifyDeployment(role, await this.client.getDeployment(candidate.id), snapshot.candidateSha);
    }
    if (candidates.length > 0 && candidates.every((deployment) => ["CANCELED", "ERROR"].includes(deployment.readyState))) {
      throw new Error(`Every matching ${role} deployment failed.`);
    }
    return null;
  }

  private async waitForDeployments(snapshot: DeploymentSnapshot) {
    const deadline = this.now() + this.prepareDeadlineMs;
    let storefront: VerifiedDeployment | null = null;
    let api: VerifiedDeployment | null = null;
    while (this.now() < deadline) {
      this.assertActive();
      storefront ??= await this.discover("storefront", snapshot);
      api ??= await this.discover("api", snapshot);
      if (storefront && api) return { api, storefront };
      await this.sleep(Math.min(this.pollIntervalMs, Math.max(0, deadline - this.now())));
    }
    throw new Error("NO_NEW_DEPLOYMENT: both current-run deployments did not become ready before the deadline.");
  }

  async prepare(snapshot: DeploymentSnapshot, manifestPath: string): Promise<StagingDeploymentManifest> {
    this.assertSnapshot(snapshot);
    await this.recover();
    let deployments = await this.waitForDeployments(snapshot);
    const currentAliases = {
      api: await this.client.getAlias(this.config.aliases.api),
      storefront: await this.client.getAlias(this.config.aliases.storefront),
    };
    for (const role of ["storefront", "api"] as const) {
      if (!sameAlias(currentAliases[role], snapshot.aliases[role])) throw new Error(`${role} alias baseline drifted after snapshot.`);
      await this.verifyAlias(role, currentAliases[role]);
    }
    await Promise.all([this.assertProject("storefront"), this.assertProject("api")]);
    deployments = {
      api: await this.verifyDeployment("api", await this.client.getDeployment(deployments.api.id), snapshot.candidateSha),
      storefront: await this.verifyDeployment(
        "storefront",
        await this.client.getDeployment(deployments.storefront.id),
        snapshot.candidateSha,
      ),
    };
    const requested = {
      api: { alias: this.config.aliases.api, deploymentId: deployments.api.id, projectId: this.config.projects.api },
      storefront: { alias: this.config.aliases.storefront, deploymentId: deployments.storefront.id, projectId: this.config.projects.storefront },
    };
    const intentId = `alias_${createHash("sha256").update(`${snapshot.attemptId}:${deployments.storefront.id}:${deployments.api.id}`).digest("hex").slice(0, 32)}`;
    const intent: AliasIntent = {
      apiAssignedAt: null,
      attemptId: snapshot.attemptId,
      candidateSha: snapshot.candidateSha,
      completedAt: null,
      createdAt: new Date(this.now()).toISOString(),
      id: intentId,
      prior: snapshot.aliases,
      projects: this.config.projects,
      requested,
      restoredAt: null,
      storefrontAssignedAt: null,
    };
    await this.ledger.createAliasIntent(intent);
    const durableIntent = await this.ledger.getAliasIntent(intentId);
    if (!durableIntent) throw new Error("Alias intent durable read-back is missing.");
    this.assertAliasIntent(durableIntent);
    if (!sameAliasIntent(durableIntent, intent)) {
      throw new Error("Alias intent durable read-back differs from the requested mutation.");
    }
    try {
      for (const role of ["storefront", "api"] as const) {
        this.assertActive();
        await this.client.assignAlias(requested[role].deploymentId, requested[role].alias);
        const assignedAt = new Date(this.now()).toISOString();
        await this.ledger.markAliasAssigned(intentId, role, assignedAt);
        const actual = await this.client.getAlias(requested[role].alias, true);
        if (!sameAlias(actual, requested[role])) throw new Error(`${role} alias assignment read-back failed.`);
      }
      await this.verifyAlias("storefront", requested.storefront, snapshot.candidateSha);
      await this.verifyAlias("api", requested.api, snapshot.candidateSha);
      const verifiedAt = new Date(this.now()).toISOString();
      const manifest: StagingDeploymentManifest = {
        aliases: {
          api: { alias: requested.api.alias, newTarget: requested.api.deploymentId, priorTarget: snapshot.aliases.api.deploymentId, verifiedAt },
          storefront: { alias: requested.storefront.alias, newTarget: requested.storefront.deploymentId, priorTarget: snapshot.aliases.storefront.deploymentId, verifiedAt },
        },
        attemptId: snapshot.attemptId,
        candidateSha: snapshot.candidateSha,
        completedAt: verifiedAt,
        deployments,
        intentId,
        registryVersion: this.config.registryVersion,
        repository: this.config.expectedRepository.fullName,
        schemaVersion: 1,
        sourceRef: "staging",
        teamId: this.config.teamId,
        workflowSha: this.config.workflowSha,
      };
      await writeAtomicJson(manifestPath, manifest);
      await this.ledger.completeAliasIntent(intentId);
      return manifest;
    } catch (error) {
      await this.recover();
      throw error;
    }
  }

  async verify(manifest: StagingDeploymentManifest) {
    this.assertManifest(manifest);
    for (const role of ["storefront", "api"] as const) {
      const deployment = await this.client.getDeployment(manifest.deployments[role].id);
      await this.verifyDeployment(role, deployment, manifest.candidateSha);
      const alias = await this.client.getAlias(this.config.aliases[role]);
      if (alias.deploymentId !== deployment.id || alias.projectId !== this.config.projects[role]) {
        throw new Error(`${role} alias drifted after the test window.`);
      }
      await this.verifyAlias(role, alias, manifest.candidateSha);
    }
    return { attemptId: manifest.attemptId, candidateSha: manifest.candidateSha, schemaVersion: 1 as const, verifiedAt: new Date(this.now()).toISOString() };
  }
}

