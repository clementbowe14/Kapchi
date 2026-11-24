import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresOwnershipLedger } from "./postgres-ledger.js";
import { VercelClient, VercelOperationError } from "./vercel-client.js";
import { readJsonFile, writeAtomicJson } from "./vercel-evidence.js";
import { PostgresAliasControlLedger } from "./vercel-ledger.js";
import { loadVercelGateConfig, VercelStagingOrchestrator } from "./vercel-orchestrator.js";
import type { DeploymentSnapshot, StagingDeploymentManifest } from "./vercel-types.js";

type Mode = "prepare" | "recover" | "snapshot" | "verify";
type CommandArguments = {
  attemptId: string;
  candidateSha: string;
  manifest?: string;
  mode: Mode;
  outputDir: string;
  snapshot?: string;
};

const FILENAMES = {
  manifest: "staging-deployment-manifest.json",
  recovery: "recovery-summary.json",
  report: "attempt-report.json",
  snapshot: "snapshot.json",
  verification: "verification-receipt.json",
} as const;

function valueAfter(argv: string[], name: string) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1] || argv[index + 1]!.startsWith("--")) {
    throw new Error(`${name} is required.`);
  }
  return argv[index + 1]!;
}
export function parseVercelCommandArguments(argv: string[]): CommandArguments {
  const mode = argv[0] as Mode;
  if (!["snapshot", "prepare", "verify", "recover"].includes(mode)) {
    throw new Error("Mode must be snapshot, prepare, verify, or recover.");
  }
  const known = new Set(["--attempt-id", "--candidate-sha", "--output-dir", "--snapshot", "--manifest"]);
  for (let index = 1; index < argv.length; index += 2) {
    if (!known.has(argv[index]!)) throw new Error(`Unknown argument: ${argv[index]}.`);
  }
  const parsed: CommandArguments = {
    attemptId: valueAfter(argv, "--attempt-id"),
    candidateSha: valueAfter(argv, "--candidate-sha"),
    mode,
    outputDir: resolve(valueAfter(argv, "--output-dir")),
  };
  if (mode === "prepare") parsed.snapshot = resolve(valueAfter(argv, "--snapshot"));
  if (mode === "verify") parsed.manifest = resolve(valueAfter(argv, "--manifest"));
  return parsed;
}
async function registryVersion() {
  const commandDirectory = dirname(fileURLToPath(import.meta.url));
  const path = resolve(commandDirectory, "../../../../deploy/staging-release-scenarios.json");
  const body = JSON.parse(await readFile(path, "utf8")) as { registryVersion?: unknown };
  if (typeof body.registryVersion !== "number" && typeof body.registryVersion !== "string") {
    throw new Error("Scenario registry version is invalid.");
  }
  return String(body.registryVersion);
}

function environment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function stableErrorCode(error: unknown) {
  if (error instanceof VercelOperationError) return error.code;
  if (error instanceof Error && error.message.startsWith("NO_NEW_DEPLOYMENT")) return "NO_NEW_DEPLOYMENT";
  return "STAGING_VERCEL_ORCHESTRATION_FAILED";
}

function emit(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...fields }));
}

async function main() {
  const args = parseVercelCommandArguments(process.argv.slice(2));
  await mkdir(args.outputDir, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  emit("staging.vercel.started", {
    attemptId: args.attemptId,
    candidateShaPrefix: args.candidateSha.slice(0, 12),
    mode: args.mode,
    startedAt,
  });
  const reportPath = resolve(args.outputDir, FILENAMES.report);
  const recoveryPath = resolve(args.outputDir, FILENAMES.recovery);
  let aliasLedger: PostgresAliasControlLedger | undefined;
  let ownershipLedger: PostgresOwnershipLedger | undefined;
  let orchestrator: VercelStagingOrchestrator | undefined;
  let recovering = false;
  let receivedSignal: NodeJS.Signals | undefined;
  const recover = async (reason: string) => {
    if (!orchestrator || recovering) return { reason, recovered: [] as string[] };
    recovering = true;
    try {
      const summary = await orchestrator.recover();
      return { reason, ...summary };
    } finally {
      recovering = false;
    }
  };
  const signalHandler = (signal: NodeJS.Signals) => {
    receivedSignal = signal;
    orchestrator?.cancel();
  };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);

  try {
    const databaseUrl = environment("STAGING_GATE_DATABASE_URL");
    const controlDatabaseId = environment("STAGING_GATE_CONTROL_DATABASE_ID");
    aliasLedger = await PostgresAliasControlLedger.connect(databaseUrl, controlDatabaseId);
    ownershipLedger = await PostgresOwnershipLedger.connect(databaseUrl, controlDatabaseId);
    const config = loadVercelGateConfig(process.env, await registryVersion());
    const client = new VercelClient(environment("STAGING_VERCEL_TOKEN"), config.teamId);
    const absolutePrepareDeadline = Number(process.env.STAGING_GATE_PREPARE_DEADLINE_EPOCH) * 1_000;
    const prepareDeadlineMs = Number.isFinite(absolutePrepareDeadline)
      ? Math.max(0, absolutePrepareDeadline - Date.now())
      : undefined;
    orchestrator = new VercelStagingOrchestrator(client, aliasLedger, config,
      prepareDeadlineMs === undefined ? {} : { prepareDeadlineMs });

    if (args.mode === "snapshot") {
      await ownershipLedger.startAttempt({
        attemptId: args.attemptId,
        candidateSha: args.candidateSha,
        expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1_000).toISOString(),
        ownerTokenHash: createHash("sha256")
          .update(`kapchi-staging-attempt:v1:${args.attemptId}:${args.candidateSha}:${config.workflowSha}`)
          .digest("hex"),
      });
      const snapshot = await orchestrator.snapshot(args.attemptId, args.candidateSha);
      await writeAtomicJson(resolve(args.outputDir, FILENAMES.snapshot), snapshot);
    } else if (args.mode === "prepare") {
      const snapshot = await readJsonFile<DeploymentSnapshot>(args.snapshot!);
      if (snapshot.attemptId !== args.attemptId || snapshot.candidateSha !== args.candidateSha) {
        throw new Error("Snapshot does not belong to this attempt and candidate.");
      }
      await orchestrator.prepare(snapshot, resolve(args.outputDir, FILENAMES.manifest));
    } else if (args.mode === "verify") {
      const manifest = await readJsonFile<StagingDeploymentManifest>(args.manifest!);
      if (manifest.attemptId !== args.attemptId || manifest.candidateSha !== args.candidateSha) {
        throw new Error("Manifest does not belong to this attempt and candidate.");
      }
      const receipt = await orchestrator.verify(manifest);
      await writeAtomicJson(resolve(args.outputDir, FILENAMES.verification), receipt);
    } else {
      const summary = await recover("explicit");
      await writeAtomicJson(recoveryPath, { ...summary, completedAt: new Date().toISOString(), schemaVersion: 1 });
    }
    await writeAtomicJson(reportPath, {
      attemptId: args.attemptId,
      candidateSha: args.candidateSha,
      completedAt: new Date().toISOString(),
      mode: args.mode,
      result: "succeeded",
      schemaVersion: 1,
      startedAt,
    });
    emit("staging.vercel.completed", {
      attemptId: args.attemptId,
      candidateShaPrefix: args.candidateSha.slice(0, 12),
      mode: args.mode,
      result: "succeeded",
    });
  } catch (error) {
    let recoveryError: string | undefined;
    try {
      const summary = await recover(receivedSignal ?? "command-failure");
      await writeAtomicJson(recoveryPath, { ...summary, completedAt: new Date().toISOString(), schemaVersion: 1 });
    } catch (failure) {
      recoveryError = failure instanceof Error ? failure.name : "UnknownError";
    }
    await writeAtomicJson(reportPath, {
      attemptId: args.attemptId,
      candidateSha: args.candidateSha,
      completedAt: new Date().toISOString(),
      errorCode: stableErrorCode(error),
      errorType: error instanceof Error ? error.name : "UnknownError",
      mode: args.mode,
      recoveryError,
      result: "failed",
      schemaVersion: 1,
      startedAt,
    });
    emit("staging.vercel.failed", {
      attemptId: args.attemptId,
      candidateShaPrefix: args.candidateSha.slice(0, 12),
      errorCode: stableErrorCode(error),
      mode: args.mode,
      recoveryError,
      result: "failed",
    });
    throw error;
  } finally {
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
    await ownershipLedger?.close();
    await aliasLedger?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(`Staging Vercel command failed (${stableErrorCode(error)}).`);
    process.exitCode = 1;
  });
}
