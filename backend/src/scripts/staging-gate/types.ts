export type StagingResourceKind =
  | "alias"
  | "blob"
  | "clerk"
  | "database"
  | "messaging"
  | "redis"
  | "stripe";

export type CleanupOutcome = "already_clean" | "deleted" | "terminal_isolated";

export type CleanupTombstone = {
  cleanedAt: string;
  evidenceDigest: string;
  outcome: CleanupOutcome;
};

export type CreationIntent = {
  attemptId: string;
  createdAt: string;
  idempotencyKey: string;
  intentId: string;
  kind: StagingResourceKind;
  namespace: string;
  providerKeyHash: string;
  targetIdentity: string;
};

export type OwnedResource = {
  attemptId: string;
  createdAt: string;
  externalId: string;
  intentId: string;
  kind: StagingResourceKind;
  namespace: string;
  targetIdentity: string;
};

export type ProvisionedFixture = {
  publicFixture?: Record<string, unknown>;
  resource: OwnedResource;
};

export type StagingAttempt = {
  attemptId: string;
  candidateSha: string;
  expiresAt: string;
  ownerTokenHash: string;
};

export type OwnershipRecord =
  | { intent: CreationIntent; resource: null; status: "creation_pending" }
  | { intent: CreationIntent; resource: OwnedResource; status: "bound" }
  | {
      intent: CreationIntent;
      resource: OwnedResource | null;
      status: "cleaned" | "terminal_isolated";
      tombstone: CleanupTombstone;
    };

export interface StagingProviderAdapter {
  readonly kind: StagingResourceKind;
  readonly targetIdentity: string;
  cleanup(resource: OwnedResource): Promise<CleanupOutcome>;
  isClean(resource: OwnedResource): Promise<boolean>;
  plan(input: { attemptId: string; namespace: string }): CreationIntent[];
  provision(intent: CreationIntent): Promise<ProvisionedFixture>;
  recover(intent: CreationIntent): Promise<ProvisionedFixture | null>;
}

export interface OwnershipLedger {
  startAttempt(attempt: StagingAttempt): Promise<void>;
  begin(intent: CreationIntent): Promise<void>;
  bind(intentId: string, resource: OwnedResource): Promise<void>;
  completeCleanup(
    intentId: string,
    resource: OwnedResource | null,
    tombstone: CleanupTombstone,
  ): Promise<void>;
  list(attemptId: string): Promise<OwnershipRecord[]>;
  markProviderCallStarted(intentId: string): Promise<void>;
}

export type StagingSafetyContext = {
  environment: "staging";
  productionDenylist: readonly string[];
};
