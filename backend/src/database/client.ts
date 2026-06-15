import type { Pool } from "pg";
import { config } from "../config/index.js";
import { createDatabasePoolFromConfig } from "./pool-factory.js";

let databasePool: Pool | undefined;

export function createDatabasePool() {
  return createDatabasePoolFromConfig({
    awsRegion: config.storage.aws.region,
    database: config.database
  });
}

export function getDatabasePool() {
  databasePool ??= createDatabasePool();
  return databasePool;
}

export async function closeDatabasePool() {
  if (!databasePool) {
    return;
  }

  await databasePool.end();
  databasePool = undefined;
}
