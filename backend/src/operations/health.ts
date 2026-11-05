import process from "node:process";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { config } from "../config/index.js";
import { closeDatabasePool, getDatabasePool } from "../database/index.js";

export type OperationalHealthCounts = {
  stripeWebhooks: number;
  messageJobs: number;
  notificationIntents: number;
  refundReconciliations: number;
  manualReviewRefunds: number;
};

export async function readOperationalHealth(pool: Pick<Pool, "query">, now = new Date()) {
  const result = await pool.query<Record<keyof OperationalHealthCounts, number | string>>(
    `select
      (select count(*) from stripe_webhook_events where processing_status = 'exhausted' or (processing_status in ('received', 'retryable', 'processing') and coalesce(next_attempt_at, received_at) < $1::timestamptz - interval '15 minutes'))::integer as "stripeWebhooks",
      (select count(*) from message_delivery_jobs where status = 'failed' or (status in ('pending', 'retryable', 'leased') and coalesce(next_attempt_at, created_at) < $1::timestamptz - interval '15 minutes'))::integer as "messageJobs",
      (select count(*) from transactional_notification_intents where status = 'failed' or (status in ('pending', 'retryable', 'leased') and next_attempt_at < $1::timestamptz - interval '15 minutes'))::integer as "notificationIntents",
      (select count(*) from payment_reconciliation_state where reconciliation_status in ('failed', 'conflicted'))::integer as "refundReconciliations",
      (select count(*) from refund_operations where manual_review_required)::integer as "manualReviewRefunds"`,
    [now.toISOString()],
  );
  const row = result.rows[0] ?? {};
  const counts: OperationalHealthCounts = {
    stripeWebhooks: Number(row.stripeWebhooks ?? 0),
    messageJobs: Number(row.messageJobs ?? 0),
    notificationIntents: Number(row.notificationIntents ?? 0),
    refundReconciliations: Number(row.refundReconciliations ?? 0),
    manualReviewRefunds: Number(row.manualReviewRefunds ?? 0)
  };
  return {
    event: "operations.health.completed" as const,
    releaseSha: config.app.releaseSha,
    checkedAt: now.toISOString(),
    actionable: Object.values(counts).some((count) => count > 0),
    counts
  };
}

export async function runOperationalHealth() {
  const result = await readOperationalHealth(getDatabasePool());
  console.info(JSON.stringify(result));
  return result.actionable ? 20 : 0;
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  runOperationalHealth().then((exitCode) => { process.exitCode = exitCode; }).catch(() => {
    console.error(JSON.stringify({ event: "operations.health.failed", releaseSha: config.app.releaseSha }));
    process.exitCode = 20;
  }).finally(() => closeDatabasePool());
}
