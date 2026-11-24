import { Pool } from "pg";
import type { AliasControlLedger, AliasIntent, ProjectRole } from "./vercel-types.js";

const CONTROL_DATABASE_ID = /^[0-9a-f]{64}$/;

type AliasIntentRow = {
  api_assigned_at: Date | string | null;
  attempt_id: string;
  candidate_sha: string;
  completed_at: Date | string | null;
  created_at: Date | string;
  intent_id: string;
  prior_targets: AliasIntent["prior"];
  projects: AliasIntent["projects"];
  requested_targets: AliasIntent["requested"];
  restored_at: Date | string | null;
  storefront_assigned_at: Date | string | null;
};

function iso(value: Date | string | null) {
  return value == null ? null : new Date(value).toISOString();
}

function rowToIntent(row: AliasIntentRow): AliasIntent {
  return {
    apiAssignedAt: iso(row.api_assigned_at),
    attemptId: row.attempt_id,
    candidateSha: row.candidate_sha,
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at)!,
    id: row.intent_id,
    prior: row.prior_targets,
    projects: row.projects,
    requested: row.requested_targets,
    restoredAt: iso(row.restored_at),
    storefrontAssignedAt: iso(row.storefront_assigned_at),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class PostgresAliasControlLedger implements AliasControlLedger {
  constructor(private readonly pool: Pool, private readonly expectedControlDatabaseId: string) {
    if (!CONTROL_DATABASE_ID.test(expectedControlDatabaseId)) {
      throw new Error("STAGING_GATE_CONTROL_DATABASE_ID must be a 64-character lowercase hex value.");
    }
  }

  static async connect(databaseUrl: string, expectedControlDatabaseId: string) {
    const url = new URL(databaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.pathname === "/") {
      throw new Error("STAGING_GATE_DATABASE_URL must identify a dedicated PostgreSQL database.");
    }
    if (!["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode") ?? "")) {
      throw new Error("STAGING_GATE_DATABASE_URL must use authenticated TLS.");
    }
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const ledger = new PostgresAliasControlLedger(pool, expectedControlDatabaseId);
    try {
      const result = await pool.query<{ environment: string; installation_id: string; purpose: string }>(
        `select environment, installation_id, purpose
           from staging_gate_control.control_plane
          where singleton = true`,
      );
      const row = result.rows[0];
      if (result.rowCount !== 1 || row?.environment !== "staging" ||
          row.purpose !== "kapchi-staging-release-gate" || row.installation_id !== expectedControlDatabaseId) {
        throw new Error("Refusing a database that is not the expected staging workflow control plane.");
      }
      return ledger;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async close() {
    await this.pool.end();
  }

  async createAliasIntent(intent: AliasIntent) {
    await this.pool.query(
      `insert into staging_gate_control.alias_intents (
         intent_id, attempt_id, candidate_sha, projects, prior_targets,
         requested_targets, created_at
       ) values ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7)
       on conflict (intent_id) do nothing`,
      [intent.id, intent.attemptId, intent.candidateSha, JSON.stringify(intent.projects),
        JSON.stringify(intent.prior), JSON.stringify(intent.requested), intent.createdAt],
    );
    const stored = await this.getAliasIntent(intent.id);
    if (!stored || canonical(stored) !== canonical(intent)) {
      throw new Error("Alias intent collision or durable read-back mismatch.");
    }
  }

  async getAliasIntent(intentId: string) {
    const result = await this.pool.query<AliasIntentRow>(
      `select * from staging_gate_control.alias_intents where intent_id = $1`,
      [intentId],
    );
    return result.rows[0] ? rowToIntent(result.rows[0]) : null;
  }

  async listUnfinishedAliasIntents() {
    const result = await this.pool.query<AliasIntentRow>(
      `select * from staging_gate_control.alias_intents
        where state = 'pending'
        order by alias_intent_id`,
    );
    return result.rows.map(rowToIntent);
  }

  async markAliasAssigned(intentId: string, role: ProjectRole, assignedAt: string) {
    const column = role === "storefront" ? "storefront_assigned_at" : "api_assigned_at";
    const result = await this.pool.query(
      `update staging_gate_control.alias_intents
          set ${column} = coalesce(${column}, $2)
        where intent_id = $1 and state = 'pending'`,
      [intentId, assignedAt],
    );
    if (result.rowCount !== 1) throw new Error("Alias assignment has no open durable intent.");
  }

  async completeAliasIntent(intentId: string) {
    const result = await this.pool.query(
      `update staging_gate_control.alias_intents
          set state = 'complete', completed_at = now()
        where intent_id = $1 and state = 'pending'
          and storefront_assigned_at is not null and api_assigned_at is not null`,
      [intentId],
    );
    if (result.rowCount !== 1) throw new Error("Alias intent cannot complete before both assignments are durable.");
  }

  async markAliasRestored(intentId: string, restoredAt: string) {
    const result = await this.pool.query(
      `update staging_gate_control.alias_intents
          set state = 'restored', restored_at = $2
        where intent_id = $1 and state = 'pending'`,
      [intentId, restoredAt],
    );
    if (result.rowCount !== 1) throw new Error("Alias intent could not be marked restored.");
  }
}

