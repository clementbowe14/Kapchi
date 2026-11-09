import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

const STRIPE_API_KEY_PATTERN = /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+\b/g;
const STRIPE_WEBHOOK_SECRET_PATTERN = /\bwhsec_[A-Za-z0-9]+\b/g;
const STRIPE_WEBHOOK_SECRET_CAPTURE = /\b(whsec_[A-Za-z0-9]+)\b/;
const DEFAULT_READY_TIMEOUT_MS = 30_000;

export function requireStripeTestApiKey(value: string | undefined) {
  const apiKey = value?.trim();
  if (!apiKey || (!apiKey.startsWith("sk_test_") && !apiKey.startsWith("rk_test_"))) {
    throw new Error(
      "STRIPE_SECRET_KEY must be a Stripe test-mode API key for local webhook development.",
    );
  }

  return apiKey;
}

export function extractStripeWebhookSecret(output: string) {
  return output.match(STRIPE_WEBHOOK_SECRET_CAPTURE)?.[1] ?? null;
}

export function redactStripeSecrets(output: string) {
  return output
    .replace(STRIPE_API_KEY_PATTERN, "[redacted Stripe API key]")
    .replace(STRIPE_WEBHOOK_SECRET_PATTERN, "[redacted Stripe webhook secret]");
}

export function localStripeWebhookUrl(portValue: string | undefined) {
  const port = Number(portValue ?? "4000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  return `http://127.0.0.1:${port}/payments/webhooks/stripe`;
}

type LocalStripeDevelopmentOptions = {
  backendCommand?: string;
  backendCommandArguments?: string[];
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
  stripeCommand?: string;
};

function stopChild(child: ChildProcess | null, signal: NodeJS.Signals) {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }
}

export function runLocalStripeDevelopment({
  backendCommand = process.platform === "win32" ? "npm.cmd" : "npm",
  backendCommandArguments = ["run", "dev"],
  cwd = process.cwd(),
  environment = process.env,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  stripeCommand = environment.STRIPE_CLI_PATH?.trim() || "stripe",
}: LocalStripeDevelopmentOptions = {}) {
  const stripeApiKey = requireStripeTestApiKey(environment.STRIPE_SECRET_KEY);
  const webhookUrl = localStripeWebhookUrl(environment.PORT);
  let backend: ChildProcess | null = null;
  let listenerOutput = "";
  let listenerReady = false;
  let shuttingDown = false;

  const listener = spawn(
    stripeCommand,
    [
      "listen",
      "--forward-to",
      webhookUrl,
      "--events",
      "checkout.session.completed,checkout.session.async_payment_succeeded,payment_intent.succeeded",
    ],
    {
      cwd,
      env: { ...environment, STRIPE_API_KEY: stripeApiKey },
      stdio: ["inherit", "pipe", "pipe"],
    },
  );

  const stopAll = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopChild(listener, signal);
    stopChild(backend, signal);
  };

  const startBackend = (webhookSecret: string) => {
    if (backend) return;

    const backendEnvironment: NodeJS.ProcessEnv = {
      ...environment,
      STRIPE_WEBHOOK_SECRET: webhookSecret,
    };
    delete backendEnvironment.STRIPE_API_KEY;

    process.stdout.write(
      `Stripe webhook forwarding is ready at ${webhookUrl}. Starting Fastify.\n`,
    );
    backend = spawn(backendCommand, backendCommandArguments, {
      cwd,
      env: backendEnvironment,
      stdio: "inherit",
    });
    backend.once("error", (error) => {
      process.stderr.write(`Unable to start Fastify: ${error.message}\n`);
      process.exitCode = 1;
      stopAll("SIGTERM");
    });
    backend.once("exit", (code, signal) => {
      if (!shuttingDown) {
        process.exitCode = code ?? (signal ? 1 : 0);
        stopAll("SIGTERM");
      }
    });
  };

  const handleListenerOutput = (chunk: Buffer, target: NodeJS.WriteStream) => {
    const text = chunk.toString("utf8");
    if (listenerReady) {
      target.write(redactStripeSecrets(text));
      return;
    }

    listenerOutput = `${listenerOutput}${text}`.slice(-64_000);
    const webhookSecret = extractStripeWebhookSecret(listenerOutput);
    if (!webhookSecret) return;

    listenerReady = true;
    clearTimeout(readyTimeout);
    listenerOutput = "";
    startBackend(webhookSecret);
  };

  listener.stdout?.on("data", (chunk: Buffer) =>
    handleListenerOutput(chunk, process.stdout),
  );
  listener.stderr?.on("data", (chunk: Buffer) =>
    handleListenerOutput(chunk, process.stderr),
  );
  listener.once("error", (error) => {
    process.stderr.write(
      `Unable to start Stripe CLI. Install it and authenticate or provide STRIPE_SECRET_KEY: ${error.message}\n`,
    );
    process.exitCode = 1;
    stopAll("SIGTERM");
  });
  listener.once("exit", (code, signal) => {
    if (!listenerReady && listenerOutput) {
      process.stderr.write(redactStripeSecrets(listenerOutput));
    }
    if (!shuttingDown) {
      process.exitCode = code ?? (signal ? 1 : 0);
      stopAll("SIGTERM");
    }
  });

  const readyTimeout = setTimeout(() => {
    if (listenerReady) return;
    process.stderr.write(
      "Stripe CLI did not provide a webhook signing secret within 30 seconds.\n",
    );
    process.exitCode = 1;
    stopAll("SIGTERM");
  }, readyTimeoutMs);

  process.once("SIGINT", () => stopAll("SIGINT"));
  process.once("SIGTERM", () => stopAll("SIGTERM"));

  return { listener };
}
