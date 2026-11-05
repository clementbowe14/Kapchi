import { Pool } from "pg";
import { loadBackendEnvironment } from "../config/load-environment.js";
import { initializeFixtureDatabase, safeFixtureFailure } from "../database/fixtures/safety.js";

loadBackendEnvironment();

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

export async function runFixtureInit() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const result = await initializeFixtureDatabase({
      confirmDatabase: option("--confirm-database"),
      databaseUrl: process.env.DATABASE_URL,
      db: pool,
      nodeEnv: process.env.NODE_ENV
    });
    process.stdout.write(`${JSON.stringify({
      databaseName: result.databaseName,
      event: "fixture.database.initialized",
      markerId: result.markerId
    })}\nKAPCHI_FIXTURE_DATABASE_TOKEN=${result.token}\n`);
  } finally {
    await pool.end();
  }
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === new URL(process.argv[1], "file:").href
  : false;

if (invokedAsScript) {
  runFixtureInit().catch((error: unknown) => {
    console.error(JSON.stringify(safeFixtureFailure(error)));
    process.exitCode = 1;
  });
}
