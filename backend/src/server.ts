import { buildServer } from "./app.js";
import { config } from "./config/index.js";

const server = await buildServer();

try {
  await server.listen({
    host: config.app.host,
    port: config.app.port
  });

  server.log.info(
    {
      host: config.app.host,
      port: config.app.port
    },
    "Kapchi backend listening",
  );
} catch (error) {
  server.log.error({ err: error }, "Failed to start Kapchi backend");
  process.exit(1);
}
