import process from "node:process";
import { Pool } from "pg";
import { loadBackendEnvironment } from "../config/load-environment.js";
import { assertIsolatedE2eDatabaseUrl } from "./e2e-database.js";

loadBackendEnvironment();

export const E2E_ADMIN_ORDER_ID = "22000000-0000-4000-8000-000000000022";
export const E2E_ADMIN_USER_ID = "22000000-0000-4000-8000-000000000001";

async function main() {
  const authSubject = process.env.E2E_ADMIN_AUTH_SUBJECT?.trim();
  if (!authSubject) throw new Error("E2E_ADMIN_AUTH_SUBJECT is required.");
  const connectionString = assertIsolatedE2eDatabaseUrl(process.env.E2E_DATABASE_URL, [
    process.env.DATABASE_URL,
    process.env.PRODUCTION_DATABASE_URL,
    process.env.STAGING_DATABASE_URL
  ]);
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into users (id, auth_provider, auth_subject, display_name, disabled_at)
       values ($1::uuid, 'clerk', $2, 'Kapchi E2E Admin', null)
       on conflict (auth_provider, auth_subject) do update
       set display_name = excluded.display_name, disabled_at = null, updated_at = now()`,
      [E2E_ADMIN_USER_ID, authSubject],
    );
    const user = await client.query<{ id: string }>(
      `select id from users where auth_provider = 'clerk' and auth_subject = $1`,
      [authSubject],
    );
    await client.query("delete from orders where id = $1::uuid", [E2E_ADMIN_ORDER_ID]);
    await client.query(
      `insert into orders (
         id, public_order_number, user_id, authenticated_user_id, status,
         payment_status, fulfillment_status, customer_email, shipping_name,
         shipping_address, subtotal_cents, total_cents, currency, paid_at, revision
       ) values (
         $1::uuid, 'KAP-E2E-22', $2, $3::uuid, 'paid', 'paid', 'queued',
         'e2e-customer@example.test', 'E2E Customer',
         '{"line1":"22 Test Way","city":"Testville","region":"NY","postalCode":"10001","country":"US"}'::jsonb,
         5000, 5000, 'usd', '2026-11-02T12:00:00Z', 0
       )`,
      [E2E_ADMIN_ORDER_ID, authSubject, user.rows[0].id],
    );
    await client.query(
      `insert into order_items (
         order_id, quantity, unit_amount_cents, total_amount_cents, currency,
         listing_snapshot, fabric_snapshot, customization_snapshot
       ) values (
         $1::uuid, 1, 5000, 5000, 'usd',
         '{"title":"E2E Graduation Stole"}'::jsonb,
         '{"name":"E2E Fabric"}'::jsonb,
         '{"level":"text_long","line1":"Class of 2027"}'::jsonb
       )`,
      [E2E_ADMIN_ORDER_ID],
    );
    await client.query("commit");
    console.log(`Reset admin-order E2E fixture ${E2E_ADMIN_ORDER_ID}.`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
