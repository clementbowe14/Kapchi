import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";

loadBackendEnvironment();

const integrationDescribe =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

integrationDescribe("admin audit database contract", () => {
  let pool: Pool;
  const userId = randomUUID();
  const authSubject = `admin-audit-${userId}`;

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
    await pool.query(
      `insert into users (id, auth_provider, auth_subject)
       values ($1, 'clerk', $2)`,
      [userId, authSubject],
    );
  });

  afterAll(async () => {
    await pool?.query(
      "delete from admin_audit_events where actor_user_id = $1",
      [userId],
    );
    await pool?.query("delete from users where id = $1", [userId]);
    await pool?.end();
  });

  it("persists verified actor and request identity and rejects replayed keys", async () => {
    const idempotencyKey = `audit-${randomUUID()}`;
    const requestId = `request-${randomUUID()}`;
    const values = [
      userId,
      authSubject,
      "promotions:write",
      "promotion.created",
      "promotion",
      randomUUID(),
      requestId,
      idempotencyKey,
      JSON.stringify({ source: "integration-test" })
    ];
    const inserted = await pool.query<{
      actor_auth_subject: string;
      actor_user_id: string;
      created_at: Date;
      idempotency_key: string;
      request_id: string;
    }>(
      `insert into admin_audit_events (
         actor_user_id, actor_auth_subject, capability, action, target_type,
         target_id, request_id, idempotency_key, metadata
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       returning actor_user_id, actor_auth_subject, request_id,
         idempotency_key, created_at`,
      values,
    );

    expect(inserted.rows[0]).toMatchObject({
      actor_auth_subject: authSubject,
      actor_user_id: userId,
      idempotency_key: idempotencyKey,
      request_id: requestId
    });
    expect(inserted.rows[0].created_at).toBeInstanceOf(Date);
    await expect(pool.query(
      `insert into admin_audit_events (
         actor_user_id, actor_auth_subject, capability, action, target_type,
         target_id, request_id, idempotency_key, metadata
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      values,
    )).rejects.toMatchObject({ code: "23505" });
  });
});
