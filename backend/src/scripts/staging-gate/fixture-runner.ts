import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CleanupOutcome,
  CleanupTombstone,
  CreationIntent,
  OwnedResource,
  OwnershipLedger,
  OwnershipRecord,
  ProvisionedFixture,
  StagingAttempt,
  StagingProviderAdapter,
  StagingSafetyContext
} from "./types.js";

const ATTEMPT_ID = /^stg_[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PRODUCTION_WORD = /(?:^|[-_.])(prod|production|live)(?:$|[-_.])/i;

export function deterministicNamespace(attemptId: string, candidateSha: string) {
  if (!ATTEMPT_ID.test(attemptId)) throw new Error("Invalid staging attempt ID.");
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) throw new Error("Candidate SHA must be a full lowercase Git SHA.");
  const attempt = attemptId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36);
  const digest = createHash("sha256").update(`${attemptId}:${candidateSha}`).digest("hex").slice(0, 12);
  return `kapchi-stg-${attempt}-${digest}`;
}

export function deterministicIntentId(
  input: Pick<CreationIntent, "attemptId" | "kind" | "namespace" | "providerKeyHash" | "targetIdentity">,
) {
  const digest = createHash("sha256")
    .update([input.attemptId, input.kind, input.namespace, input.targetIdentity, input.providerKeyHash].join(":"))
    .digest("hex");
  return `intent_${digest.slice(0, 32)}`;
}

export function deterministicProviderIdempotencyKey(
  input: Pick<CreationIntent, "attemptId" | "kind" | "namespace" | "providerKeyHash" | "targetIdentity">,
) {
  const digest = createHash("sha256")
    .update([input.attemptId, input.kind, input.namespace, input.targetIdentity, input.providerKeyHash].join(":"))
    .digest("hex");
  return `kapchi-stg:${input.kind}:${digest.slice(0, 40)}`;
}

export function assertStagingTarget(
  adapter: Pick<StagingProviderAdapter, "kind" | "targetIdentity">,
  safety: StagingSafetyContext,
) {
  if (safety.environment !== "staging") throw new Error("Fixture operations require the staging environment.");
  const target = adapter.targetIdentity.trim();
  if (!target || PRODUCTION_WORD.test(target)) {
    throw new Error(`Refusing unsafe ${adapter.kind} target.`);
  }
  if (safety.productionDenylist.some((entry) => entry === target)) {
    throw new Error(`Refusing production-denylisted ${adapter.kind} target.`);
  }
}

export async function pollBounded(
  predicate: () => Promise<boolean>,
  options: { intervalMs: number; timeoutMs: number },
) {
  const deadline = Date.now() + options.timeoutMs;
  do {
    if (await predicate()) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  } while (Date.now() <= deadline);
  throw new Error("Staging resource cleanup did not converge before the deadline.");
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cleanupTombstone(
  intent: CreationIntent,
  resource: OwnedResource | null,
  outcome: CleanupOutcome,
): CleanupTombstone {
  const cleanedAt = new Date().toISOString();
  const evidenceDigest = createHash("sha256")
    .update(JSON.stringify({ cleanedAt, intent, outcome, resource }))
    .digest("hex");
  return { cleanedAt, evidenceDigest, outcome };
}

export class JsonOwnershipLedger implements OwnershipLedger {
  constructor(private readonly path: string) {}

  async startAttempt(attempt: StagingAttempt) {
    const state = await this.readState();
    const existing = state.attempts.find((candidate) => candidate.attemptId === attempt.attemptId);
    if (existing) {
      if (!sameJson(existing, attempt)) throw new Error("Staging attempt ownership collision.");
      return;
    }
    state.attempts.push(attempt);
    await this.writeDurably(state);
  }

  async begin(intent: CreationIntent) {
    const state = await this.readState();
    const records = state.records;
    if (!state.attempts.some(({ attemptId }) => attemptId === intent.attemptId)) {
      throw new Error("Cannot record a resource intent before its staging attempt.");
    }
    const existing = records.find((record) => record.intent.intentId === intent.intentId);
    if (existing) {
      if (!sameJson(existing.intent, intent)) throw new Error("Creation intent ID collision.");
      return;
    }
    records.push({ intent, resource: null, status: "creation_pending" });
    await this.writeDurably(state);
  }

  async bind(intentId: string, resource: OwnedResource) {
    const state = await this.readState();
    const records = state.records;
    const index = records.findIndex((record) => record.intent.intentId === intentId);
    if (index < 0) throw new Error("Cannot bind a provider handle without a durable creation intent.");
    const existing = records[index]!;
    if (existing.status === "cleaned" || existing.status === "terminal_isolated") {
      throw new Error("Cannot bind a provider handle to a closed intent.");
    }
    if (existing.status === "bound") {
      if (!sameJson(existing.resource, resource)) throw new Error("Creation intent is already bound to another provider handle.");
      return;
    }
    records[index] = { intent: existing.intent, resource, status: "bound" };
    await this.writeDurably(state);
  }

  async markProviderCallStarted(intentId: string) {
    const records = (await this.readState()).records;
    if (!records.some((record) => record.intent.intentId === intentId)) {
      throw new Error("Cannot start a provider call without a durable creation intent.");
    }
  }

  async list(attemptId: string) {
    return (await this.readState()).records.filter((record) => record.intent.attemptId === attemptId);
  }

  async completeCleanup(
    intentId: string,
    resource: OwnedResource | null,
    tombstone: CleanupTombstone,
  ) {
    const state = await this.readState();
    const records = state.records;
    const index = records.findIndex((record) => record.intent.intentId === intentId);
    if (index < 0) throw new Error("Cannot complete cleanup for an unknown creation intent.");
    const existing = records[index]!;
    if (existing.status === "cleaned" || existing.status === "terminal_isolated") {
      if (!sameJson(existing.resource, resource) || !sameJson(existing.tombstone, tombstone)) {
        throw new Error("Cleanup tombstones are immutable.");
      }
      return;
    }
    if (resource && existing.status === "bound" && !sameJson(existing.resource, resource)) {
      throw new Error("Cleanup resource does not match the bound provider handle.");
    }
    if (!SHA256.test(tombstone.evidenceDigest) || Number.isNaN(Date.parse(tombstone.cleanedAt))) {
      throw new Error("Cleanup tombstone evidence is invalid.");
    }
    records[index] = {
      intent: existing.intent,
      resource,
      status: tombstone.outcome === "terminal_isolated" ? "terminal_isolated" : "cleaned",
      tombstone,
    };
    await this.writeDurably(state);
  }

  private async readState(): Promise<{ attempts: StagingAttempt[]; records: OwnershipRecord[] }> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (
        !value || typeof value !== "object" ||
        !Array.isArray((value as { attempts?: unknown }).attempts) ||
        !Array.isArray((value as { records?: unknown }).records)
      ) {
        throw new Error("Ownership ledger is invalid.");
      }
      return value as { attempts: StagingAttempt[]; records: OwnershipRecord[] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { attempts: [], records: [] };
      throw error;
    }
  }

  private async writeDurably(state: { attempts: StagingAttempt[]; records: OwnershipRecord[] }) {
    const directory = dirname(this.path);
    await mkdir(directory, { mode: 0o700, recursive: true });
    const temporary = `${this.path}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
      await chmod(temporary, 0o600);
    } finally {
      await file.close();
    }
    await rename(temporary, this.path);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
}

type PlannedIntent = { adapter: StagingProviderAdapter; intent: CreationIntent };

export class StagingFixtureRunner {
  private readonly adapters: Map<string, StagingProviderAdapter>;

  constructor(
    adapters: readonly StagingProviderAdapter[],
    private readonly ledger: OwnershipLedger,
    private readonly safety: StagingSafetyContext,
    private readonly polling = { intervalMs: 100, timeoutMs: 10_000 },
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
    if (this.adapters.size !== adapters.length) throw new Error("Only one adapter per resource kind is allowed.");
    adapters.forEach((adapter) => assertStagingTarget(adapter, safety));
  }

  async prepare(
    attemptId: string,
    candidateSha: string,
    ownership: { expiresAt: string; ownerTokenHash: string },
  ) {
    const expiresAt = Date.parse(ownership.expiresAt);
    if (!SHA256.test(ownership.ownerTokenHash)) {
      throw new Error("Staging attempt owner token hash must be a lowercase SHA-256 digest.");
    }
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 24 * 60 * 60 * 1000) {
      throw new Error("Staging attempt expiry must be within the next 24 hours.");
    }
    const namespace = deterministicNamespace(attemptId, candidateSha);
    await this.ledger.startAttempt({
      attemptId,
      candidateSha,
      expiresAt: new Date(expiresAt).toISOString(),
      ownerTokenHash: ownership.ownerTokenHash,
    });
    const plans: PlannedIntent[] = [];
    for (const adapter of this.adapters.values()) {
      const intents = adapter.plan({ attemptId, namespace });
      for (const intent of intents) {
        this.assertIntent(intent, adapter, attemptId, namespace);
        plans.push({ adapter, intent });
      }
    }
    const intentIds = plans.map(({ intent }) => intent.intentId);
    const idempotencyKeys = plans.map(({ intent }) => intent.idempotencyKey);
    if (
      new Set(intentIds).size !== intentIds.length ||
      new Set(idempotencyKeys).size !== idempotencyKeys.length
    ) {
      throw new Error("Each planned provider mutation requires a distinct creation intent and idempotency key.");
    }

    // Every creation intent is durable before the first provider read or write.
    for (const { intent } of plans) await this.ledger.begin(intent);

    const publicFixtures: Record<string, unknown>[] = [];
    try {
      for (const { adapter, intent } of plans) {
        const current = (await this.ledger.list(attemptId))
          .find((record) => record.intent.intentId === intent.intentId);
        if (!current) throw new Error("Durable creation intent disappeared before provider execution.");
        if (current.status === "cleaned" || current.status === "terminal_isolated") {
          throw new Error("A closed creation intent cannot be reprovisioned.");
        }

        await this.ledger.markProviderCallStarted(intent.intentId);
        let fixture: ProvisionedFixture | null;
        if (current.status === "bound") {
          fixture = await adapter.recover(intent);
          if (!fixture) fixture = { resource: current.resource };
        } else {
          fixture = await adapter.recover(intent);
          if (!fixture) fixture = await adapter.provision(intent);
        }
        this.assertOwned(fixture.resource, intent, adapter);
        await this.ledger.bind(intent.intentId, fixture.resource);
        if (fixture.publicFixture) publicFixtures.push(fixture.publicFixture);
      }
      return { attemptId, namespace, publicFixtures };
    } catch (error) {
      await this.cleanup(attemptId, namespace).catch(() => undefined);
      throw error;
    }
  }

  async cleanup(attemptId: string, expectedNamespace?: string) {
    if (!ATTEMPT_ID.test(attemptId)) throw new Error("Invalid staging attempt ID.");
    const records = await this.ledger.list(attemptId);
    const outcomes: Array<{ intentId: string; kind: string; outcome: CleanupOutcome }> = [];
    const failures: unknown[] = [];
    for (const record of [...records].reverse()) {
      try {
        const adapter = this.adapters.get(record.intent.kind);
        if (!adapter) throw new Error(`No cleanup adapter exists for ${record.intent.kind}.`);
        assertStagingTarget(adapter, this.safety);
        this.assertIntent(
          record.intent,
          adapter,
          attemptId,
          expectedNamespace ?? record.intent.namespace,
        );
        if (record.status === "cleaned" || record.status === "terminal_isolated") {
          outcomes.push({ intentId: record.intent.intentId, kind: record.intent.kind, outcome: "already_clean" });
          continue;
        }

        let resource = record.status === "bound" ? record.resource : null;
        if (!resource) {
          await this.ledger.markProviderCallStarted(record.intent.intentId);
          const recovered = await adapter.recover(record.intent);
          if (!recovered) {
            await this.ledger.completeCleanup(
              record.intent.intentId,
              null,
              cleanupTombstone(record.intent, null, "already_clean"),
            );
            outcomes.push({ intentId: record.intent.intentId, kind: record.intent.kind, outcome: "already_clean" });
            continue;
          }
          this.assertOwned(recovered.resource, record.intent, adapter);
          await this.ledger.bind(record.intent.intentId, recovered.resource);
          resource = recovered.resource;
        }
        this.assertOwned(resource, record.intent, adapter);
        await this.ledger.markProviderCallStarted(record.intent.intentId);
        const outcome = await adapter.cleanup(resource);
        await pollBounded(() => adapter.isClean(resource), this.polling);
        await this.ledger.completeCleanup(
          record.intent.intentId,
          resource,
          cleanupTombstone(record.intent, resource, outcome),
        );
        outcomes.push({ intentId: record.intent.intentId, kind: record.intent.kind, outcome });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more staging resources could not be cleaned.");
    }
    return outcomes;
  }

  private assertIntent(
    intent: CreationIntent,
    adapter: StagingProviderAdapter,
    attemptId: string,
    namespace: string,
  ) {
    if (
      intent.attemptId !== attemptId ||
      intent.namespace !== namespace ||
      intent.kind !== adapter.kind ||
      intent.targetIdentity !== adapter.targetIdentity ||
      !SHA256.test(intent.providerKeyHash) ||
      intent.intentId !== deterministicIntentId(intent) ||
      intent.idempotencyKey !== deterministicProviderIdempotencyKey(intent) ||
      Number.isNaN(Date.parse(intent.createdAt))
    ) {
      throw new Error("Refusing an invalid or foreign staging creation intent.");
    }
  }

  private assertOwned(
    resource: OwnedResource,
    intent: CreationIntent,
    adapter: StagingProviderAdapter,
  ) {
    if (
      resource.intentId !== intent.intentId ||
      resource.attemptId !== intent.attemptId ||
      resource.namespace !== intent.namespace ||
      resource.kind !== adapter.kind ||
      resource.targetIdentity !== adapter.targetIdentity ||
      !resource.externalId ||
      PRODUCTION_WORD.test(resource.externalId) ||
      this.safety.productionDenylist.includes(resource.externalId) ||
      Number.isNaN(Date.parse(resource.createdAt))
    ) {
      throw new Error("Refusing to mutate a resource outside this staging attempt.");
    }
  }
}
