import { spawn } from "node:child_process";

const publicPort = process.env.PORT ?? "8080";
const backendPort = process.env.BACKEND_PORT ?? "4000";
const backendHost = process.env.BACKEND_HOST ?? "localhost";

const children = new Set();
let shuttingDown = false;

function startProcess(name, command, args, env) {
  const child = spawn(command, args, {
    env: {
      ...process.env,
      ...env
    },
    stdio: "inherit"
  });

  children.add(child);

  child.on("exit", (code, signal) => {
    children.delete(child);

    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.error(
      `${name} exited unexpectedly${signal ? ` from ${signal}` : ""}${
        code === null ? "" : ` with code ${code}`
      }`,
    );
    stopChildren();
    process.exit(code ?? 1);
  });

  return child;
}

function stopChildren() {
  for (const child of children) {
    child.kill("SIGTERM");
  }
}

process.on("SIGINT", () => {
  shuttingDown = true;
  stopChildren();
});

process.on("SIGTERM", () => {
  shuttingDown = true;
  stopChildren();
});

startProcess("backend", "node", ["/app/backend/dist/server.js"], {
  HOST: backendHost,
  PORT: backendPort
});

startProcess(
  "frontend",
  "node",
  [
    "/app/client/node_modules/next/dist/bin/next",
    "start",
    "-H",
    "0.0.0.0",
    "-p",
    publicPort
  ],
  {
    BACKEND_INTERNAL_URL:
      process.env.BACKEND_INTERNAL_URL ?? `http://${backendHost}:${backendPort}`
  },
);
