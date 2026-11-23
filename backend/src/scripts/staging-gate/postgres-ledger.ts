import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type {
  CleanupTombstone,
  CreationIntent,
  OwnedResource,
  OwnershipLedger,
  OwnershipRecord,
  StagingAttempt,
  StagingResourceKind,
} from "./types.js";

const CONTROL_DATABASE_ID = /^[0-9a-f]{64}$/;
const ATTEMPT_ID = /^stg_[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;
const CANDIDATE_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type AttemptRow = {
  attempt_id: string;
  candidate_sha: string;
  expires_at: Date | string;
  owner_token_hash: string;
  state: "active" | "cleaned" | "cleanup-pending" | "failed" | "preparing";
};

type LedgerRow = {
  attempt_id: string;
  cleanup_outcome: CleanupTombstone["outcome"] | null;
  cleanup_verified_at: Date | string | null;
  evidence_digest: string | null;
  expected_account_hash: string;
  idempotency_key: string;
  intent_id: string;
  intent_recorded_at: Date | string;
  namespace: string;
  provider: StagingResourceKind;
  provider_handle: string | null;
  resource_created_at: Date | string | null;
  state: "bound" | "cleaned" | "cleanup-failed" | "cleanup-pending" | "creation-pending" | "terminal-isolated";
  target_identity: string;
};

function iso(value: Date | string) {
  return new Date(value).toISOString();
}

function rowToRecord(row: LedgerRow): OwnershipRecord {
  const intent: CreationIntent = {
    attemptId: row.attempt_id,
    createdAt: iso(row.intent_recorded_at),
    idempotencyKey: row.idempotency_key,
    intentId: row.intent_id,
    kind: row.provider,
    namespace: row.namespace,
    providerKeyHash: row.expected_account_hash,
    targetIdentity: row.target_identity,
  };
  const resource = row.provider_handle && row.resource_created_at
    ? {
        attemptId: row.attempt_id,
        createdAt: iso(row.resource_created_at),
        externalId: row.provider_handle,
        intentId: row.intent_id,
        kind: row.provider,
        namespace: row.namespace,
        targetIdentity: row.target_identity,
      }
    : null;
  if (row.state === "cleaned" || row.state === "terminal-isolated") {
    if (!row.cleanup_outcome || !row.cleanup_verified_at || !row.evidence_digest) {
      throw new Error("Control database contains an incomplete cleanup tombstone.");
    }
    return {
      intent,
      resource,
      status: row.state === "terminal-isolated" ? "terminal_isolated" : "cleaned",
      tombstone: {
        cleanedAt: iso(row.cleanup_verified_at),
        evidenceDigest: row.evidence_digest,
        outcome: row.cleanup_outcome,
      },
    };
  }
  return resource
    ? { intent, resource, status: "bound" }
    : { intent, resource: null, status: "creation_pending" };
}

export class PostgresOwnershipLedger implements OwnershipLedger {
  constructor(
    private readonly pool: Pool,
    private readonly expectedControlDatabaseId: string,
  ) {
    if (!CONTROL_DATABASE_ID.test(expectedControlDatabaseId)) {
      throw new Error("STAGING_GATE_CONTROL_DATABASE_ID must be a 64-character lowercase hex value.");
    }
  }

  static async connect(databaseUrl: string, expectedControlDatabaseId: string) {
    const parsed = new URL(databaseUrl);
    if (!parsed.pathname || parsed.pathname === "/" || !parsed.protocol.startsWith("postgres")) {
      throw new Error("STAGING_GATE_DATABASE_URL must identify a dedicated PostgreSQL database.");
    }
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const ledger = new PostgresOwnershipLedger(pool, expectedControlDatabaseId);
    try {
      await ledger.assertControlPlane();
      return ledger;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async close() {
    await this.pool.end();
  }

  async assertControlPlane(client: Pool | PoolClient = this.pool) {
    const result = await client.query<{
      environment: string;
      installation_id: string;
      purpose: string;
    }>(`select environment, installation_id, purpose
          from staging_gate_control.control_plane
         where singleton = true`);
    const control = result.rows[0];
    if (
      result.rowCount !== 1 ||
      control?.environment !== "staging" ||
      control.purpose !== "kapchi-staging-release-gate" ||
      control.installation_id !== this.expectedControlDatabaseId
    ) {
      throw new Error("Refusing a database that is not the expected staging workflow control plane.");
    }
  }

  async startAttempt(attempt: StagingAttempt) {
    const expiresAt = Date.parse(attempt.expiresAt);
    if (
      !ATTEMPT_ID.test(attempt.attemptId) ||
      !CANDIDATE_SHA.test(attempt.candidateSha) ||
      !SHA256.test(attempt.ownerTokenHash) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + 24 * 60 * 60 * 1000
    ) {
      throw new Error("Staging attempt ownership, candidate, or expiry is invalid.");
    }
    await this.pool.query(
      `insert into staging_gate_control.attempts (
         attempt_id, candidate_sha, owner_token_hash, state, expires_at
       ) values ($1,$2,$3,'active',$4)
       on conflict (attempt_id) do nothing`,
      [attempt.attemptId, attempt.candidateSha, attempt.ownerTokenHash, attempt.expiresAt],
    );
    const result = await this.pool.query<AttemptRow>(
      `select attempt_id, candidate_sha, owner_token_hash, state, expires_at
         from staging_gate_control.attempts
        where attempt_id = $1`,
      [attempt.attemptId],
    );
    const stored = result.rows[0];
    if (
      result.rowCount !== 1 ||
      stored?.candidate_sha !== attempt.candidateSha ||
      stored.owner_token_hash !== attempt.ownerTokenHash ||
      iso(stored.expires_at) !== new Date(expiresAt).toISOString() ||
      !["preparing", "active"].includes(stored.state)
    ) {
      throw new Error("Staging attempt ID belongs to another owner, candidate, expiry, or terminal run.");
    }
  }

  async begin(intent: CreationIntent) {
    await this.pool.query(
      `insert into staging_gate_control.resource_intents (
         intent_id, attempt_id, provider, namespace, idempotency_key,
         target_identity, expected_account_hash, intent_recorded_at
       )
       select $1,$2,$3,$4,$5,$6,$7,$8
         from staging_gate_control.attempts
        where attempt_id = $2
          and state in ('preparing', 'active')
          and expires_at > now()
       on conflict (intent_id) do nothing`,
      [
        intent.intentId,
        intent.attemptId,
        intent.kind,
        intent.namespace,
        intent.idempotencyKey,
        intent.targetIdentity,
        intent.providerKeyHash,
        intent.createdAt,
      ],
    );
    const rows = await this.list(intent.attemptId);
    const stored = rows.find((record) => record.intent.intentId === intent.intentId);
    if (!stored || JSON.stringify(stored.intent) !== JSON.stringify(intent)) {
      throw new Error("Creation intent ID collision in the workflow control database.");
    }
  }

  async markProviderCallStarted(intentId: string) {
    const result = await this.pool.query(
      `update staging_gate_control.resource_intents
          set provider_call_started_at = coalesce(provider_call_started_at, now())
        where intent_id = $1
          and state not in ('cleaned', 'terminal-isolated')`,
      [intentId],
    );
    if (result.rowCount !== 1) throw new Error("Provider call has no open durable creation intent.");
  }

  async bind(intentId: string, resource: OwnedResource) {
    const handleHash = createHash("sha256").update(resource.externalId).digest("hex");
    const result = await this.pool.query(
      `update staging_gate_control.resource_intents
          set provider_handle = $2,
              provider_handle_hash = $3,
              resource_created_at = $4,
              bound_at = coalesce(bound_at, now()),
              state = 'bound'
        where intent_id = $1
          and state in ('creation-pending', 'bound', 'cleanup-pending', 'cleanup-failed')
          and (provider_handle is null or provider_handle = $2)`,
      [intentId, resource.externalId, handleHash, resource.createdAt],
    );
    if (result.rowCount !== 1) throw new Error("Provider handle could not be bound to its durable intent.");
  }

  async completeCleanup(
    intentId: string,
    resource: OwnedResource | null,
    tombstone: CleanupTombstone,
  ) {
    const terminal = tombstone.outcome === "terminal_isolated";
    const result = await this.pool.query(
      `update staging_gate_control.resource_intents
          set state = $2,
              provider_handle = coalesce(provider_handle, $3),
              provider_handle_hash = coalesce(provider_handle_hash, $4),
              resource_created_at = coalesce(resource_created_at, $5),
              cleanup_started_at = coalesce(cleanup_started_at, now()),
              cleanup_verified_at = $6,
              cleanup_outcome = $7,
              absence_verified = $8,
              terminal_state_verified = $9,
              evidence_digest = $10
        where intent_id = $1
          and state not in ('cleaned', 'terminal-isolated')`,
      [
        intentId,
        terminal ? "terminal-isolated" : "cleaned",
        resource?.externalId ?? null,
        resource ? createHash("sha256").update(resource.externalId).digest("hex") : null,
        resource?.createdAt ?? null,
        tombstone.cleanedAt,
        tombstone.outcome,
        !terminal,
        terminal,
        tombstone.evidenceDigest,
      ],
    );
    if (result.rowCount === 1) return;
    const existing = await this.pool.query<LedgerRow>(
      `select * from staging_gate_control.resource_intents where intent_id = $1`,
      [intentId],
    );
    const record = existing.rows[0] && rowToRecord(existing.rows[0]);
    if (
      !record ||
      (record.status !== "cleaned" && record.status !== "terminal_isolated") ||
      JSON.stringify(record.tombstone) !== JSON.stringify(tombstone)
    ) {
      throw new Error("Cleanup tombstone is missing or immutable evidence does not match.");
    }
  }

  async list(attemptId: string) {
    const result = await this.pool.query<LedgerRow>(
      `select * from staging_gate_control.resource_intents
        where attempt_id = $1
        order by resource_intent_id`,
      [attemptId],
    );
    return result.rows.map(rowToRecord);
  }

  async claimExpiredAttempts() {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.assertControlPlane(client);
      const attempts = await client.query<{ attempt_id: string }>(
        `update staging_gate_control.attempts
            set state = 'cleanup-pending'
          where expires_at <= now()
            and state in ('preparing', 'active', 'cleanup-pending')
          returning attempt_id`,
      );
      await client.query(
        `update staging_gate_control.resource_intents r
            set state = 'cleanup-pending',
                cleanup_started_at = coalesce(cleanup_started_at, now())
           from staging_gate_control.attempts a
          where r.attempt_id = a.attempt_id
            and a.state = 'cleanup-pending'
            and r.state in ('creation-pending', 'bound', 'cleanup-failed')`,
      );
      await client.query("commit");
      return attempts.rows.map((row) => row.attempt_id);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async finalizeAttempt(attemptId: string) {
    const result = await this.pool.query(
      `update staging_gate_control.attempts a
          set state = 'cleaned', finalized_at = now()
        where a.attempt_id = $1
          and a.state = 'cleanup-pending'
          and not exists (
            select 1 from staging_gate_control.resource_intents r
             where r.attempt_id = a.attempt_id
               and r.state not in ('cleaned', 'terminal-isolated')
          )`,
      [attemptId],
    );
    if (result.rowCount !== 1) throw new Error("Attempt still has resources without terminal cleanup evidence.");
  }
}
