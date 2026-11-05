import { Pool } from "pg";
import { loadBackendEnvironment } from "../config/load-environment.js";
import { FIXTURE_ADMIN_SUBJECT, fixtureIdentities } from "../database/fixtures/admin-workflows.js";
import {
  acquireFixtureTransactionLock,
  assertInitializedFixtureDatabase,
  fingerprint,
  safeFixtureFailure,
  sha256,
  stableJson
} from "../database/fixtures/safety.js";

loadBackendEnvironment();

function subjectArgument() {
  const index = process.argv.indexOf("--subject");
  return index < 0 ? undefined : process.argv[index + 1];
}

function adminOwnership(subject: string) {
  const admin = fixtureIdentities.find((entry) => entry.key === "identity.admin")!;
  return {
    canonicalFingerprint: fingerprint({
      email: admin.email,
      name: admin.displayName,
      phone: admin.phone,
      subject
    }),
    naturalKeyHash: sha256(stableJson({ provider: "clerk", subject }))
  };
}

export async function bindFixtureAdmin(subject = subjectArgument()) {
  if (!subject?.trim()) throw new Error("FIXTURE_ADMIN_SUBJECT_REQUIRED");
  const admin = fixtureIdentities.find((entry) => entry.key === "identity.admin")!;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertInitializedFixtureDatabase({ databaseUrl: process.env.DATABASE_URL, db: client, nodeEnv: process.env.NODE_ENV, token: process.env.KAPCHI_FIXTURE_DATABASE_TOKEN });
    await acquireFixtureTransactionLock(client);
    const collision = await client.query<{ id: string }>(
      "select id::text from users where auth_provider='clerk' and auth_subject=$1 and id<>$2",
      [subject, admin.userId],
    );
    if (collision.rows[0]) throw new Error("FIXTURE_ADMIN_SUBJECT_COLLISION");
    const owner = await client.query(
      "select 1 from kapchi_fixture.owned_rows where fixture_key='identity.admin.user' and row_id=$1",
      [admin.userId],
    );
    if (!owner.rows[0]) throw new Error("FIXTURE_ADMIN_NOT_SEEDED");
    await client.query("update users set auth_subject=$1 where id=$2", [subject, admin.userId]);
    const ownership = adminOwnership(subject);
    await client.query(
      `update kapchi_fixture.owned_rows
          set natural_key_hash=$2, canonical_fingerprint=$3, updated_at=now()
        where fixture_key='identity.admin.user' and row_id=$1`,
      [admin.userId, ownership.naturalKeyHash, ownership.canonicalFingerprint],
    );
    await client.query(
      `insert into kapchi_fixture.admin_bindings (fixture_user_id,subject_hash)
       values ($1,$2) on conflict (fixture_user_id) do update set subject_hash=excluded.subject_hash,bound_at=now()`,
      [admin.userId, sha256(subject)],
    );
    await client.query("commit");
    console.log(JSON.stringify({ event: "fixture.admin.bound", fixtureUserId: admin.userId }));
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
const invokedAsScript = process.argv[1]
  ? import.meta.url === new URL(process.argv[1], "file:").href
  : false;

if (invokedAsScript) {
  bindFixtureAdmin().catch((error: unknown) => {
    console.error(JSON.stringify(safeFixtureFailure(error)));
    process.exitCode = 1;
  });
}

export async function unbindFixtureAdmin() {
  const admin = fixtureIdentities.find((entry) => entry.key === "identity.admin")!;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertInitializedFixtureDatabase({ databaseUrl: process.env.DATABASE_URL, db: client, nodeEnv: process.env.NODE_ENV, token: process.env.KAPCHI_FIXTURE_DATABASE_TOKEN });
    await acquireFixtureTransactionLock(client);
    await client.query("update users set auth_subject=$1 where id=$2", [FIXTURE_ADMIN_SUBJECT, admin.userId]);
    const ownership = adminOwnership(FIXTURE_ADMIN_SUBJECT);
    await client.query(
      `update kapchi_fixture.owned_rows
          set natural_key_hash=$2, canonical_fingerprint=$3, updated_at=now()
        where fixture_key='identity.admin.user' and row_id=$1`,
      [admin.userId, ownership.naturalKeyHash, ownership.canonicalFingerprint],
    );
    await client.query("delete from kapchi_fixture.admin_bindings where fixture_user_id=$1", [admin.userId]);
    await client.query("commit");
    console.log(JSON.stringify({ event: "fixture.admin.unbound", fixtureUserId: admin.userId }));
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
