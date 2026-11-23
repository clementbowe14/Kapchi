import { Pool } from "pg";
import { loadBackendEnvironment } from "../config/load-environment.js";
import { seedIntegrationCatalog } from "../database/seed.js";
import {
  FixtureSafetyError,
  acquireFixtureTransactionLock,
  assertInitializedFixtureDatabase,
  initializeFixtureDatabase,
  safeFixtureFailure
} from "../database/fixtures/safety.js";

loadBackendEnvironment();

export async function runIntegrationCatalogSeed() {
  const confirmDatabase = process.env.KAPCHI_FIXTURE_CONFIRM_DATABASE;
  const token = process.env.KAPCHI_FIXTURE_DATABASE_TOKEN;
  if (!token) throw new FixtureSafetyError("FIXTURE_DATABASE_TOKEN_MISSING");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

  try {
    try {
      await initializeFixtureDatabase({
        confirmDatabase,
        databaseUrl: process.env.DATABASE_URL,
        db: pool,
        nodeEnv: process.env.NODE_ENV,
        token
      });
    } catch (error) {
      if (!(error instanceof FixtureSafetyError) || error.code !== "FIXTURE_DATABASE_ALREADY_INITIALIZED") {
        throw error;
      }
      await assertInitializedFixtureDatabase({
        databaseUrl: process.env.DATABASE_URL,
        db: pool,
        nodeEnv: process.env.NODE_ENV,
        token
      });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await acquireFixtureTransactionLock(client);
      const result = await seedIntegrationCatalog(client);
      await client.query("commit");
      process.stdout.write(`${JSON.stringify({
        event: "fixture.integration-catalog.seeded",
        ...result
      })}\n`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === new URL(process.argv[1], "file:").href
  : false;

if (invokedAsScript) {
  runIntegrationCatalogSeed().catch((error: unknown) => {
    console.error(JSON.stringify(safeFixtureFailure(error)));
    process.exitCode = 1;
  });
}
