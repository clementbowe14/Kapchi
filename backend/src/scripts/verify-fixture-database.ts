import { Pool } from "pg";
import { loadBackendEnvironment } from "../config/load-environment.js";
import { verifyFixtureDatabase } from "../database/fixtures/verifier.js";
import { safeFixtureFailure } from "../database/fixtures/safety.js";

loadBackendEnvironment();

export async function runFixtureVerify() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const result = await verifyFixtureDatabase({
      databaseUrl: process.env.DATABASE_URL,
      db: pool,
      expectedStripeAccountId: process.env.KAPCHI_STRIPE_TEST_ACCOUNT_ID,
      nodeEnv: process.env.NODE_ENV,
      token: process.env.KAPCHI_FIXTURE_DATABASE_TOKEN
    });
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === new URL(process.argv[1], "file:").href
  : false;

if (invokedAsScript) {
  runFixtureVerify().catch((error: unknown) => {
    console.error(JSON.stringify(safeFixtureFailure(error)));
    process.exitCode = 1;
  });
}
