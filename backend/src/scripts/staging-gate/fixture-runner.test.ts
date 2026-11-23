import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deterministicIntentId,
  deterministicNamespace,
  deterministicProviderIdempotencyKey,
  JsonOwnershipLedger,
  StagingFixtureRunner
} from "./fixture-runner.js";
import type {
  CleanupOutcome,
  CleanupTombstone,
  CreationIntent,
  OwnedResource,
  OwnershipLedger,
  OwnershipRecord,
  StagingAttempt,
  StagingProviderAdapter
} from "./types.js";

class MemoryLedger implements OwnershipLedger {
  records: OwnershipRecord[] = [];
  attempts: StagingAttempt[] = [];
  constructor(private readonly events: string[] = []) {}

  async startAttempt(attempt: StagingAttempt) {
    this.events.push(`attempt:${attempt.attemptId}`);
    const existing = this.attempts.find(({ attemptId }) => attemptId === attempt.attemptId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(attempt)) {
      throw new Error("attempt collision");
    }
    if (!existing) this.attempts.push(attempt);
  }

  async begin(intent: CreationIntent) {
    this.events.push(`begin:${intent.intentId}`);
    if (!this.records.some((record) => record.intent.intentId === intent.intentId)) {
      this.records.push({ intent, resource: null, status: "creation_pending" });
    }
  }

  async bind(intentId: string, resource: OwnedResource) {
    this.events.push(`bind:${intentId}`);
    const index = this.records.findIndex((record) => record.intent.intentId === intentId);
    if (index < 0) throw new Error("missing intent");
    this.records[index] = { intent: this.records[index]!.intent, resource, status: "bound" };
  }

  async list(attemptId: string) {
    return this.records.filter((record) => record.intent.attemptId === attemptId);
  }

  async markProviderCallStarted(intentId: string) {
    this.events.push(`provider-started:${intentId}`);
  }

  async completeCleanup(
    intentId: string,
    resource: OwnedResource | null,
    tombstone: CleanupTombstone,
  ) {
    this.events.push(`complete:${intentId}`);
    const index = this.records.findIndex((record) => record.intent.intentId === intentId);
    if (index < 0) throw new Error("missing intent");
    this.records[index] = {
      intent: this.records[index]!.intent,
      resource,
      status: tombstone.outcome === "terminal_isolated" ? "terminal_isolated" : "cleaned",
      tombstone,
    };
  }
}

const attemptId = "stg_fixture_12345678";
const candidateSha = "a".repeat(40);
const namespace = deterministicNamespace(attemptId, candidateSha);
const targetIdentity = "kapchi-staging-clerk";
const safety = {
  environment: "staging" as const,
  productionDenylist: ["kapchi-production-clerk"]
};
const temporaryDirectories: string[] = [];

function attemptOwnership() {
  return {
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ownerTokenHash: "c".repeat(64),
  };
}

function intent(providerKey: string, kind = "clerk" as const): CreationIntent {
  const base = {
    attemptId,
    createdAt: "2026-11-23T00:00:00.000Z",
    kind,
    namespace,
    providerKeyHash: Buffer.from(providerKey).toString("hex").padEnd(64, "0").slice(0, 64),
    targetIdentity
  };
  return {
    ...base,
    idempotencyKey: deterministicProviderIdempotencyKey(base),
    intentId: deterministicIntentId(base)
  };
}

function resource(source: CreationIntent): OwnedResource {
  return {
    attemptId: source.attemptId,
    createdAt: source.createdAt,
    externalId: `${source.namespace}/${source.intentId}`,
    intentId: source.intentId,
    kind: source.kind,
    namespace: source.namespace,
    targetIdentity: source.targetIdentity
  };
}

function adapter(
  intents: CreationIntent[],
  events: string[] = [],
  overrides: Partial<StagingProviderAdapter> = {},
): StagingProviderAdapter {
  return {
    kind: "clerk",
    targetIdentity,
    plan: vi.fn(() => intents),
    provision: vi.fn(async (creationIntent) => {
      events.push(`provider:${creationIntent.intentId}`);
      return {
        publicFixture: { roleIntentId: creationIntent.intentId },
        resource: resource(creationIntent)
      };
    }),
    recover: vi.fn(async (creationIntent) => {
      events.push(`recover:${creationIntent.intentId}`);
      return null;
    }),
    cleanup: vi.fn(async (): Promise<CleanupOutcome> => "deleted"),
    isClean: vi.fn(async () => true),
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { force: true, recursive: true }),
  ));
});

describe("staging fixture write-ahead ownership", () => {
  it("durably records every multi-resource intent before the first provider call", async () => {
    const events: string[] = [];
    const intents = [intent("clerk-customer"), intent("clerk-non-admin"), intent("clerk-admin")];
    const ledger = new MemoryLedger(events);
    const provider = adapter(intents, events);
    const runner = new StagingFixtureRunner([provider], ledger, safety);

    const prepared = await runner.prepare(attemptId, candidateSha, attemptOwnership());

    expect(prepared.publicFixtures).toHaveLength(3);
    expect(ledger.records).toHaveLength(3);
    expect(ledger.records.every((record) => record.status === "bound")).toBe(true);
    const firstProvider = events.findIndex((entry) => entry.startsWith("provider:"));
    expect(events[0]).toBe(`attempt:${attemptId}`);
    const writeAheadEvents = events.filter((entry) => entry.startsWith("begin:"));
    expect(writeAheadEvents).toHaveLength(3);
    expect(events.slice(0, firstProvider).filter((entry) => entry.startsWith("begin:"))).toHaveLength(3);
    expect(new Set(intents.map(({ intentId }) => intentId)).size).toBe(3);
    expect(new Set(intents.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(3);
  });

  it("makes no provider call when any write-ahead intent cannot be recorded", async () => {
    const intents = [intent("clerk-customer"), intent("clerk-admin")];
    const ledger = new MemoryLedger();
    ledger.begin = vi.fn(async (creationIntent) => {
      if (creationIntent.intentId === intents[1]!.intentId) throw new Error("ledger unavailable");
      ledger.records.push({ intent: creationIntent, resource: null, status: "creation_pending" });
    });
    const provider = adapter(intents);
    const runner = new StagingFixtureRunner([provider], ledger, safety);

    await expect(runner.prepare(attemptId, candidateSha, attemptOwnership())).rejects.toThrow("ledger unavailable");
    expect(provider.recover).not.toHaveBeenCalled();
    expect(provider.provision).not.toHaveBeenCalled();
  });

  it("recovers and binds a provider handle left behind by a pending intent", async () => {
    const creationIntent = intent("clerk-customer");
    const ledger = new MemoryLedger();
    await ledger.begin(creationIntent);
    const recovered = { resource: resource(creationIntent) };
    const provider = adapter([creationIntent], [], {
      recover: vi.fn(async () => recovered)
    });
    const runner = new StagingFixtureRunner([provider], ledger, safety);

    await expect(runner.cleanup(attemptId, namespace)).resolves.toEqual([
      { intentId: creationIntent.intentId, kind: "clerk", outcome: "deleted" }
    ]);
    expect(ledger.records[0]!.status).toBe("cleaned");
    expect(provider.cleanup).toHaveBeenCalledWith(recovered.resource);
    expect(ledger.records[0]).toMatchObject({
      tombstone: { evidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/), outcome: "deleted" },
    });
  });

  it("closes a pending intent when recovery proves no provider resource exists", async () => {
    const creationIntent = intent("clerk-customer");
    const ledger = new MemoryLedger();
    await ledger.begin(creationIntent);
    const provider = adapter([creationIntent]);
    const runner = new StagingFixtureRunner([provider], ledger, safety);

    await expect(runner.cleanup(attemptId, namespace)).resolves.toEqual([
      { intentId: creationIntent.intentId, kind: "clerk", outcome: "already_clean" }
    ]);
    expect(ledger.records[0]!.status).toBe("cleaned");
    expect(ledger.records[0]).toMatchObject({
      resource: null,
      tombstone: { outcome: "already_clean" },
    });
    expect(provider.cleanup).not.toHaveBeenCalled();
  });

  it("does not repeat provider cleanup after a terminal tombstone is persisted", async () => {
    const creationIntent = intent("clerk-customer");
    const ledger = new MemoryLedger();
    const provider = adapter([creationIntent]);
    const runner = new StagingFixtureRunner([provider], ledger, safety);
    await runner.prepare(attemptId, candidateSha, attemptOwnership());

    await runner.cleanup(attemptId, namespace);
    await expect(runner.cleanup(attemptId, namespace)).resolves.toEqual([
      { intentId: creationIntent.intentId, kind: "clerk", outcome: "already_clean" },
    ]);
    expect(provider.cleanup).toHaveBeenCalledTimes(1);
  });

  it("persists creation_pending before binding in the JSON ledger", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kapchi-ledger-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "ownership.json");
    const ledger = new JsonOwnershipLedger(path);
    const creationIntent = intent("clerk-customer");

    await ledger.startAttempt({ attemptId, candidateSha, ...attemptOwnership() });
    await ledger.begin(creationIntent);
    expect(JSON.parse(await readFile(path, "utf8")).records[0]).toMatchObject({
      intent: { intentId: creationIntent.intentId },
      resource: null,
      status: "creation_pending"
    });
    await ledger.bind(creationIntent.intentId, resource(creationIntent));
    expect((await ledger.list(attemptId))[0]).toMatchObject({
      resource: { intentId: creationIntent.intentId },
      status: "bound"
    });
    await ledger.completeCleanup(creationIntent.intentId, resource(creationIntent), {
      cleanedAt: "2026-11-23T00:01:00.000Z",
      evidenceDigest: "b".repeat(64),
      outcome: "deleted",
    });
    expect((await ledger.list(attemptId))[0]).toMatchObject({
      status: "cleaned",
      tombstone: { evidenceDigest: "b".repeat(64), outcome: "deleted" },
    });
  });

  it("rejects production-like targets and altered resource ownership", async () => {
    expect(() => new StagingFixtureRunner([
      adapter([], [], { targetIdentity: "kapchi-production-clerk" })
    ], new MemoryLedger(), safety)).toThrow(/unsafe|denylisted/);

    const creationIntent = intent("clerk-customer");
    const ledger = new MemoryLedger();
    const provider = adapter([creationIntent]);
    const runner = new StagingFixtureRunner([provider], ledger, safety);
    await runner.prepare(attemptId, candidateSha, attemptOwnership());
    const bound = ledger.records[0]!;
    if (bound.status !== "bound") throw new Error("expected bound fixture");
    ledger.records[0] = {
      ...bound,
      resource: { ...bound.resource, namespace: "foreign-run" }
    };
    await expect(runner.cleanup(attemptId, namespace)).rejects.toThrow(
      "One or more staging resources could not be cleaned",
    );
  });

  it("bounds cleanup polling", async () => {
    const creationIntent = intent("clerk-customer");
    const provider = adapter([creationIntent], [], { isClean: vi.fn(async () => false) });
    const runner = new StagingFixtureRunner([provider], new MemoryLedger(), safety, {
      intervalMs: 1,
      timeoutMs: 2
    });
    await runner.prepare(attemptId, candidateSha, attemptOwnership());
    await expect(runner.cleanup(attemptId, namespace)).rejects.toThrow(
      "One or more staging resources could not be cleaned",
    );
  });
});
