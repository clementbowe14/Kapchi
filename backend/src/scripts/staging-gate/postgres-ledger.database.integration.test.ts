import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresOwnershipLedger } from "./postgres-ledger.js";
import type { CreationIntent, OwnedResource, StagingAttempt } from "./types.js";

const databaseUrl = process.env.STAGING_GATE_DATABASE_URL;
const controlDatabaseId = process.env.STAGING_GATE_CONTROL_DATABASE_ID;
const integrationDescribe =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" && databaseUrl && controlDatabaseId
    ? describe
    : describe.skip;

integrationDescribe("PostgresOwnershipLedger control-plane lifecycle", () => {
  let ledger: PostgresOwnershipLedger;
  let pool: Pool;

  const suffix = randomBytes(6).toString("hex");
  const attemptId = `stg_ledger_${suffix}`;
  const intentId = `intent_${randomBytes(16).toString("hex")}`;
  const namespace = `kapchi-stg-ledger-${suffix}`;
  const attempt: StagingAttempt = {
    attemptId,
    candidateSha: "a".repeat(40),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ownerTokenHash: "b".repeat(64),
  };
  const intent: CreationIntent = {
    attemptId,
    createdAt: new Date(Date.now() - 33 * 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey: `ledger-integration-${suffix}`,
    intentId,
    kind: "alias",
    namespace,
    providerKeyHash: "c".repeat(64),
    targetIdentity: `vercel-staging-project-${suffix}`,
  };
  const resource: OwnedResource = {
    attemptId,
    createdAt: new Date().toISOString(),
    externalId: `user_${suffix}`,
    intentId,
    kind: "alias",
    namespace,
    targetIdentity: intent.targetIdentity,
  };

  beforeAll(async () => {
    ledger = await PostgresOwnershipLedger.connect(databaseUrl!, controlDatabaseId!);
    pool = new Pool({ connectionString: databaseUrl!, max: 1 });
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(
        `truncate table
           staging_gate_control.resource_intents,
           staging_gate_control.attempts
         restart identity`,
      );
      await pool.end();
    }
    await ledger?.close();
  });

  it("rejects a control database whose durable installation identity differs", async () => {
    await expect(
      PostgresOwnershipLedger.connect(databaseUrl!, "d".repeat(64)),
    ).rejects.toThrow("not the expected staging workflow control plane");
  });

  it("persists write-ahead ownership, claims expiry, and finalizes immutable cleanup", async () => {
    await ledger.startAttempt(attempt);

    const attemptRow = await pool.query(
      `select candidate_sha, owner_token_hash, state
         from staging_gate_control.attempts
        where attempt_id = $1`,
      [attemptId],
    );
    expect(attemptRow.rows).toEqual([{
      candidate_sha: attempt.candidateSha,
      owner_token_hash: attempt.ownerTokenHash,
      state: "active",
    }]);

    await ledger.begin(intent);
    const writeAhead = await pool.query(
      `select provider_call_started_at, provider_handle, state
         from staging_gate_control.resource_intents
        where intent_id = $1`,
      [intentId],
    );
    expect(writeAhead.rows).toEqual([{
      provider_call_started_at: null,
      provider_handle: null,
      state: "creation-pending",
    }]);

    await ledger.markProviderCallStarted(intentId);
    await ledger.bind(intentId, resource);
    const [bound] = await ledger.list(attemptId);
    expect(bound).toMatchObject({
      intent,
      resource,
      status: "bound",
    });

    await pool.query(
      `update staging_gate_control.attempts
          set created_at = now() - interval '2 hours',
              expires_at = now() - interval '1 hour'
        where attempt_id = $1`,
      [attemptId],
    );
    await expect(ledger.claimExpiredAttempts()).resolves.toContain(attemptId);

    const claimed = await pool.query(
      `select a.state as attempt_state, r.state as resource_state
         from staging_gate_control.attempts a
         join staging_gate_control.resource_intents r using (attempt_id)
        where a.attempt_id = $1`,
      [attemptId],
    );
    expect(claimed.rows).toEqual([{
      attempt_state: "cleanup-pending",
      resource_state: "cleanup-pending",
    }]);
    await expect(ledger.finalizeAttempt(attemptId)).rejects.toThrow(
      "resources without terminal cleanup evidence",
    );

    await pool.query(
      `update staging_gate_control.resource_intents
          set cleanup_started_at = now() - interval '32 days'
        where intent_id = $1`,
      [intentId],
    );
    const tombstone = {
      cleanedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      evidenceDigest: "e".repeat(64),
      outcome: "deleted" as const,
    };
    await ledger.completeCleanup(intentId, resource, tombstone);

    await expect(
      pool.query(
        `update staging_gate_control.resource_intents
            set evidence_digest = $2
          where intent_id = $1`,
        [intentId, "f".repeat(64)],
      ),
    ).rejects.toThrow("cleanup tombstones are immutable");

    await ledger.finalizeAttempt(attemptId);
    const finalized = await pool.query(
      `select state, finalized_at is not null as finalized
         from staging_gate_control.attempts
        where attempt_id = $1`,
      [attemptId],
    );
    expect(finalized.rows).toEqual([{ finalized: true, state: "cleaned" }]);
  });
});
