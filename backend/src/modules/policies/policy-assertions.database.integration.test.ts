import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import { snapshotForInsertion } from "./policy-contract.js";

loadBackendEnvironment();

const integrationDescribe =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

async function expectDatabaseError(
  client: PoolClient,
  name: string,
  query: () => Promise<unknown>,
  code: string,
) {
  await client.query(`savepoint ${name}`);
  try {
    await query();
    throw new Error(`Expected PostgreSQL error ${code}.`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  } finally {
    await client.query(`rollback to savepoint ${name}`);
  }
}

integrationDescribe("order policy assertion persistence", () => {
  let pool: Pool;

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("allows historical null evidence and enforces immutable valid snapshots", async () => {
    const client = await pool.connect();
    const historicalOrderId = randomUUID();
    const assertedOrderId = randomUUID();
    const malformedOrderId = randomUUID();
    const policy = snapshotForInsertion();

    try {
      await client.query("begin");
      await client.query(
        `insert into orders (id, public_order_number) values ($1, $2), ($3, $4)`,
        [
          historicalOrderId,
          `POLICY-HISTORICAL-${historicalOrderId}`,
          assertedOrderId,
          `POLICY-ASSERTED-${assertedOrderId}`
        ],
      );

      const historical = await client.query(
        "select order_id from order_policy_assertions where order_id = $1",
        [historicalOrderId],
      );
      expect(historical.rows).toEqual([]);

      const inserted = await client.query<{ statement_submitted_at: Date }>(
        `
          insert into order_policy_assertions (
            order_id, schema_version, bundle_version, effective_date,
            checkout_statement_version, checkout_statement_digest,
            documents, assertions
          ) values ($1, $2, $3, $4::date, $5, $6, $7::jsonb, $8::jsonb)
          returning statement_submitted_at
        `,
        [
          assertedOrderId,
          policy.schemaVersion,
          policy.bundleVersion,
          policy.effectiveDate,
          policy.checkoutStatement.version,
          policy.checkoutStatement.digest,
          JSON.stringify(policy.documents),
          JSON.stringify(policy.assertions)
        ],
      );
      expect(inserted.rows[0]?.statement_submitted_at).toBeInstanceOf(Date);

      await expectDatabaseError(
        client,
        "immutable_update",
        () => client.query(
          "update order_policy_assertions set bundle_version = $2 where order_id = $1",
          [assertedOrderId, "changed"],
        ),
        "55000",
      );
      await expectDatabaseError(
        client,
        "immutable_delete",
        () => client.query(
          "delete from order_policy_assertions where order_id = $1",
          [assertedOrderId],
        ),
        "55000",
      );

      await client.query(
        "insert into orders (id, public_order_number) values ($1, $2)",
        [malformedOrderId, `POLICY-MALFORMED-${malformedOrderId}`],
      );
      await expectDatabaseError(
        client,
        "malformed_assertion",
        () => client.query(
          `
            insert into order_policy_assertions (
              order_id, schema_version, bundle_version, effective_date,
              checkout_statement_version, checkout_statement_digest,
              documents, assertions
            ) values ($1, 1, $2, $3::date, $2, $4, '[]'::jsonb, $5::jsonb)
          `,
          [
            malformedOrderId,
            policy.bundleVersion,
            policy.effectiveDate,
            policy.checkoutStatement.digest,
            JSON.stringify(policy.assertions)
          ],
        ),
        "23514",
      );
      await expectDatabaseError(
        client,
        "false_assertion",
        () => client.query(
          `
            insert into order_policy_assertions (
              order_id, schema_version, bundle_version, effective_date,
              checkout_statement_version, checkout_statement_digest,
              documents, assertions
            ) values ($1, 1, $2, $3::date, $2, $4, $5::jsonb, $6::jsonb)
          `,
          [
            malformedOrderId,
            policy.bundleVersion,
            policy.effectiveDate,
            policy.checkoutStatement.digest,
            JSON.stringify(policy.documents),
            JSON.stringify({ returnsAcknowledged: true, termsAgreed: false })
          ],
        ),
        "23514",
      );
      const missingRoleDocuments = policy.documents.map((document) => {
        if (document.key !== "shipping") {
          return document;
        }
        const { role: _role, ...withoutRole } = document;
        return withoutRole;
      });
      await expectDatabaseError(
        client,
        "missing_document_role",
        () => client.query(
          `
            insert into order_policy_assertions (
              order_id, schema_version, bundle_version, effective_date,
              checkout_statement_version, checkout_statement_digest,
              documents, assertions
            ) values ($1, 1, $2, $3::date, $2, $4, $5::jsonb, $6::jsonb)
          `,
          [
            malformedOrderId,
            policy.bundleVersion,
            policy.effectiveDate,
            policy.checkoutStatement.digest,
            JSON.stringify(missingRoleDocuments),
            JSON.stringify(policy.assertions)
          ],
        ),
        "23514",
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
