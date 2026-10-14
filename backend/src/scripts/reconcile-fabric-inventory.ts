import { closeDatabasePool, getDatabasePool } from "../database/index.js";
import { expireStaleFabricReservations } from "../modules/admin-inventory/lifecycle.js";

const pool = getDatabasePool();
const client = await pool.connect();

try {
  await client.query("begin");
  const result = await expireStaleFabricReservations(client);
  await client.query("commit");
  console.info(JSON.stringify({
    event: "inventory.fabric_reservations.reconciled",
    ...result
  }));
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
  await closeDatabasePool();
}
