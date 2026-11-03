import { closeDatabasePool, getDatabasePool } from "../database/index.js";
import { ShippingExportRepository } from "../modules/shipping/repository.js";

const pool = getDatabasePool();

try {
  const result = await new ShippingExportRepository(pool).purgeExpired(100);
  console.info(JSON.stringify({
    event: "shipping.export.batch.purged",
    purgedCount: result.purged
  }));
} finally {
  await closeDatabasePool();
}
