import { closeDatabasePool, getDatabasePool } from "../database/index.js";
import { createStripeClient } from "../modules/payments/stripe-client.js";
import { StripeRefundProvider } from "../modules/refunds/provider.js";
import { RefundRepository } from "../modules/refunds/repository.js";
import { RefundService } from "../modules/refunds/service.js";
import { StripeWebhookInbox } from "../modules/refunds/webhook-inbox.js";

const pool = getDatabasePool();
const provider = new StripeRefundProvider(createStripeClient());
const repository = new RefundRepository(pool);
const observer = {
  error: (event: string, fields?: Record<string, unknown>) =>
    console.error(JSON.stringify({ event, ...fields })),
  info: (event: string, fields?: Record<string, unknown>) =>
    console.info(JSON.stringify({ event, ...fields })),
  warn: (event: string, fields?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ event, ...fields }))
};

try {
  const inbox = new StripeWebhookInbox(pool, provider);
  const refunds = new RefundService(repository, provider, observer);
  const [webhookResult, refundResult] = await Promise.all([
    inbox.runOnce(50),
    refunds.runRecovery(50)
  ]);
  console.info(
    JSON.stringify({
      event: "refund.reconciliation.completed",
      refunds: refundResult,
      webhooks: webhookResult
    }),
  );
} finally {
  await closeDatabasePool();
}

