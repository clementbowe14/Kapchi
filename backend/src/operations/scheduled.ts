import process from "node:process";
import type { Pool } from "pg";
import { config } from "../config/index.js";
import { getDatabasePool } from "../database/index.js";
import { expireStaleFabricReservations } from "../modules/admin-inventory/lifecycle.js";
import { HttpMessageProvider } from "../modules/admin-messaging/provider.js";
import { AdminMessagingRepository } from "../modules/admin-messaging/repository.js";
import { AdminMessagingService } from "../modules/admin-messaging/service.js";
import { TransactionalNotificationOperationsAdapter } from "../modules/admin-messaging/transactional-operations.js";
import { createStripeClient } from "../modules/payments/stripe-client.js";
import { StripeRefundProvider } from "../modules/refunds/provider.js";
import { RefundRepository } from "../modules/refunds/repository.js";
import { RefundService } from "../modules/refunds/service.js";
import { StripeWebhookInbox } from "../modules/refunds/webhook-inbox.js";
import { ShippingExportRepository } from "../modules/shipping/repository.js";
import { readOperationalHealth } from "./health.js";

export const scheduledOperationNames = ["messages", "refunds", "inventory", "maintenance", "health"] as const;
export type ScheduledOperationName = typeof scheduledOperationNames[number];
export type ScheduledOperation = { run: () => Promise<unknown>; timeoutMs: number };
export type ScheduledOperations = Record<ScheduledOperationName, ScheduledOperation>;

type Observer = {
  error: (event: string, fields?: Record<string, unknown>) => void;
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
};

function observer(log: { error: (fields: object, message: string) => void; info: (fields: object, message: string) => void; warn: (fields: object, message: string) => void }): Observer {
  return {
    error: (event, fields) => log.error({ event, ...fields }, "Scheduled operation failed"),
    info: (event, fields) => log.info({ event, ...fields }, "Scheduled operation completed"),
    warn: (event, fields) => log.warn({ event, ...fields }, "Scheduled operation warning")
  };
}

export function createScheduledOperations(
  log: Parameters<typeof observer>[0],
  pool: Pool = getDatabasePool(),
): ScheduledOperations {
  const serviceObserver = observer(log);

  return {
    messages: {
      timeoutMs: 45_000,
      run: async () => {
        const service = new AdminMessagingService(
          new AdminMessagingRepository(pool),
          new HttpMessageProvider(config.messaging.delivery),
          config.messaging.senders,
          serviceObserver,
          new TransactionalNotificationOperationsAdapter(
            pool,
            process.env.ORDER_LOOKUP_BASE_URL ?? "http://localhost:3000",
            config.app.nodeEnv,
          ),
        );
        return service.runDelivery(50);
      }
    },
    refunds: {
      timeoutMs: 45_000,
      run: async () => {
        const provider = new StripeRefundProvider(createStripeClient());
        return Promise.all([
          new StripeWebhookInbox(pool, provider).runOnce(50),
          new RefundService(new RefundRepository(pool), provider, serviceObserver).runRecovery(50)
        ]);
      }
    },
    inventory: {
      timeoutMs: 45_000,
      run: async () => {
        const client = await pool.connect();
        try {
          await client.query("begin");
          const result = await expireStaleFabricReservations(client);
          await client.query("commit");
          return result;
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      }
    },
    maintenance: {
      timeoutMs: 45_000,
      run: async () => Promise.all([
        new ShippingExportRepository(pool).purgeExpired(100),
        pool.query("delete from asset_upload_callbacks where expires_at <= now()")
      ])
    },
    health: {
      timeoutMs: 15_000,
      run: async () => readOperationalHealth(pool)
    }
  };
}
