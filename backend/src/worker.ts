import process from "node:process";
import { pathToFileURL } from "node:url";
import { config } from "./config/index.js";
import { closeDatabasePool, getDatabasePool } from "./database/index.js";
import { expireStaleFabricReservations } from "./modules/admin-inventory/lifecycle.js";
import { HttpMessageProvider } from "./modules/admin-messaging/provider.js";
import { AdminMessagingRepository } from "./modules/admin-messaging/repository.js";
import { AdminMessagingService } from "./modules/admin-messaging/service.js";
import { TransactionalNotificationOperationsAdapter } from "./modules/admin-messaging/transactional-operations.js";
import { createStripeClient } from "./modules/payments/stripe-client.js";
import { StripeRefundProvider } from "./modules/refunds/provider.js";
import { RefundRepository } from "./modules/refunds/repository.js";
import { RefundService } from "./modules/refunds/service.js";
import { StripeWebhookInbox } from "./modules/refunds/webhook-inbox.js";
import { ShippingExportRepository } from "./modules/shipping/repository.js";
import { startWorkerLoops, type WorkerOperation } from "./worker-runtime.js";

const observer = {
  error: (fields: Record<string, unknown>) => console.error(JSON.stringify(fields)),
  info: (fields: Record<string, unknown>) => console.info(JSON.stringify(fields))
};
const serviceObserver = {
  error: (event: string, fields?: Record<string, unknown>) => observer.error({ event, ...fields }),
  info: (event: string, fields?: Record<string, unknown>) => observer.info({ event, ...fields }),
  warn: (event: string, fields?: Record<string, unknown>) => console.warn(JSON.stringify({ event, ...fields }))
};

export function createWorkerOperations(): WorkerOperation[] {
  const pool = getDatabasePool();
  const stripe = createStripeClient();
  const refundProvider = new StripeRefundProvider(stripe);
  return [
    {
      intervalMs: 10_000,
      name: "messages.dispatch",
      timeoutMs: 8_000,
      run: async () => {
        const service = new AdminMessagingService(
          new AdminMessagingRepository(pool),
          new HttpMessageProvider(config.messaging.delivery),
          config.messaging.senders,
          serviceObserver,
          new TransactionalNotificationOperationsAdapter(pool, process.env.ORDER_LOOKUP_BASE_URL ?? "http://localhost:3000", config.app.nodeEnv),
        );
        await service.runDelivery(50);
      }
    },
    {
      intervalMs: 30_000,
      name: "refunds.reconcile",
      timeoutMs: 25_000,
      run: async () => {
        await Promise.all([
          new StripeWebhookInbox(pool, refundProvider).runOnce(50),
          new RefundService(new RefundRepository(pool), refundProvider, serviceObserver).runRecovery(50)
        ]);
      }
    },
    {
      intervalMs: 60_000,
      name: "inventory.reconcile",
      timeoutMs: 10_000,
      run: async () => {
        const client = await pool.connect();
        try {
          await client.query("begin");
          await expireStaleFabricReservations(client);
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      }
    },
    {
      intervalMs: 15 * 60_000,
      name: "shipping.exports.purge",
      timeoutMs: 30_000,
      run: async () => { await new ShippingExportRepository(pool).purgeExpired(100); }
    },
    {
      intervalMs: 15 * 60_000,
      name: "assets.callback-retention",
      timeoutMs: 10_000,
      run: async () => {
        await pool.query(`delete from asset_upload_callbacks where expires_at <= now()`);
      }
    }
  ];
}

export async function runWorker() {
  const stop = startWorkerLoops(createWorkerOperations(), observer);
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    observer.info({ event: "worker.shutdown.started", signal });
    await stop();
    await closeDatabasePool();
    observer.info({ event: "worker.shutdown.completed", signal });
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  runWorker().catch((error) => {
    observer.error({ event: "worker.start.failed", errorCode: error instanceof Error ? error.name : "WORKER_START_FAILED" });
    process.exitCode = 1;
  });
}
