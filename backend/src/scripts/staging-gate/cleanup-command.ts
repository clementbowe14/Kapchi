import { ClerkStagingAdapter } from "./clerk-adapter.js";
import { StagingFixtureRunner } from "./fixture-runner.js";
import { PostgresOwnershipLedger } from "./postgres-ledger.js";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main() {
  const ledger = await PostgresOwnershipLedger.connect(
    required("STAGING_GATE_DATABASE_URL"),
    required("STAGING_GATE_CONTROL_DATABASE_ID"),
  );
  try {
    const adapter = new ClerkStagingAdapter(
      required("STAGING_CLERK_TARGET_IDENTITY"),
      required("CLERK_SECRET_KEY"),
    );
    const runner = new StagingFixtureRunner([adapter], ledger, {
      environment: "staging",
      productionDenylist: required("STAGING_PRODUCTION_IDENTITY_DENYLIST").split(",").map((value) => value.trim()),
    }, { intervalMs: 500, timeoutMs: 15_000 });
    const attempts = await ledger.claimExpiredAttempts();
    for (const attemptId of attempts) {
      await runner.cleanup(attemptId);
      await ledger.finalizeAttempt(attemptId);
      process.stdout.write(`${JSON.stringify({ attemptId, event: "staging.cleanup.completed" })}\n`);
    }
  } finally {
    await ledger.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    errorCode: "STAGING_CLEANUP_FAILED",
    event: "staging.cleanup.failed",
    reason: error instanceof Error ? error.message : "unknown error",
  })}\n`);
  process.exitCode = 1;
});
