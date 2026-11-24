export type ProjectRole = "api" | "storefront";

export type ReleaseIdentity = {
  environment: string;
  environmentIdentity: string;
  registryVersion: string;
  releaseDeploymentId: string;
  releaseSha: string;
};

export type VercelDeployment = {
  createdAt: number;
  id: string;
  projectId: string;
  readyAt?: number;
  readyState: "BUILDING" | "CANCELED" | "ERROR" | "INITIALIZING" | "QUEUED" | "READY";
  ref?: string;
  sha?: string;
  target: "preview" | "production" | null;
  url: string;
};

export type VercelAlias = {
  alias: string;
  deploymentId: string;
  projectId: string;
};

export type VercelProject = {
  id: string;
  name: string;
  productionBranch: string;
  repository?: {
    name?: string;
    owner?: string;
    repoId?: string;
    type?: string;
  };
  protectionEnabled: boolean;
};

export type VercelEnvironmentVariable = {
  gitBranch?: string;
  key: string;
  targets: string[];
};

export type DeploymentSnapshot = {
  attemptId: string;
  candidateSha: string;
  createdAt: string;
  deployments: Record<ProjectRole, string[]>;
  projects: Record<ProjectRole, VercelProject>;
  aliases: Record<ProjectRole, VercelAlias>;
  schemaVersion: 1;
};

export type VerifiedDeployment = VercelDeployment & {
  release: ReleaseIdentity;
  verifiedAt: string;
};

export type AliasIntent = {
  attemptId: string;
  candidateSha: string;
  completedAt: string | null;
  createdAt: string;
  id: string;
  projects: Record<ProjectRole, string>;
  prior: Record<ProjectRole, VercelAlias>;
  requested: Record<ProjectRole, VercelAlias>;
  restoredAt: string | null;
  storefrontAssignedAt: string | null;
  apiAssignedAt: string | null;
};

export type StagingDeploymentManifest = {
  aliases: Record<ProjectRole, {
    alias: string;
    newTarget: string;
    priorTarget: string;
    verifiedAt: string;
  }>;
  attemptId: string;
  candidateSha: string;
  completedAt: string;
  deployments: Record<ProjectRole, VerifiedDeployment>;
  intentId: string;
  registryVersion: string;
  repository: string;
  schemaVersion: 1;
  sourceRef: "staging";
  teamId: string;
  workflowSha: string;
};

export interface AliasControlLedger {
  completeAliasIntent(intentId: string): Promise<void>;
  createAliasIntent(intent: AliasIntent): Promise<void>;
  getAliasIntent(intentId: string): Promise<AliasIntent | null>;
  listUnfinishedAliasIntents(): Promise<AliasIntent[]>;
  markAliasAssigned(intentId: string, role: ProjectRole, assignedAt: string): Promise<void>;
  markAliasRestored(intentId: string, restoredAt: string): Promise<void>;
}

