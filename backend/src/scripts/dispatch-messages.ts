import { config } from "../config/index.js";
import { closeDatabasePool, getDatabasePool } from "../database/index.js";
import { HttpMessageProvider } from "../modules/admin-messaging/provider.js";
import { AdminMessagingRepository } from "../modules/admin-messaging/repository.js";
import { AdminMessagingService } from "../modules/admin-messaging/service.js";

const observer = {
  error: (event: string, fields?: Record<string, unknown>) =>
    console.error(JSON.stringify({ event, ...fields })),
  info: (event: string, fields?: Record<string, unknown>) =>
    console.info(JSON.stringify({ event, ...fields })),
  warn: (event: string, fields?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ event, ...fields }))
};

try {
  const repository = new AdminMessagingRepository(getDatabasePool());
  const service = new AdminMessagingService(
    repository,
    new HttpMessageProvider(config.messaging.delivery),
    config.messaging.senders,
    observer,
  );
  const result = await service.runDelivery(50);
  console.info(JSON.stringify({ event: "message.dispatch.completed", ...result }));
} finally {
  await closeDatabasePool();
}
