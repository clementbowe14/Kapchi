#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readFile, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const identitySql = String.raw`
select json_build_object(
  'database', current_database(),
  'databaseOid', (select oid::text from pg_database where datname = current_database()),
  'serverAddress', coalesce(inet_server_addr()::text, 'local-socket'),
  'serverPort', inet_server_port(),
  'systemIdentifier', (select system_identifier::text from pg_control_system()),
  'serverVersionNum', current_setting('server_version_num'),
  'currentUser', current_user,
  'markerExists', to_regclass('kapchi_restore_guard.target') is not null,
  'nonGuardRelations', (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      and n.nspname not in ('pg_catalog', 'information_schema', 'kapchi_restore_guard')
      and n.nspname not like 'pg_toast%'
  )
);`;

const markerSql = String.raw`
select json_build_object(
  'markerCount', count(*),
  'markerDatabase', min(database_name),
  'markerDigest', min(marker_token_sha256)
)
from kapchi_restore_guard.target;`;

const integritySql = String.raw`
select json_build_object(
  'orders', (select count(*) from orders),
  'orderItems', (select count(*) from order_items),
  'stripeWebhooks', (select count(*) from stripe_webhook_events),
  'refunds', (select count(*) from refund_operations),
  'manualReviewRefunds', (select count(*) from refund_operations where manual_review_required = true),
  'messages', (select count(*) from message_delivery_jobs),
  'notifications', (select count(*) from transactional_notification_intents),
  'reservations', (select count(*) from fabric_reservations),
  'shippingExports', (select count(*) from shipping_export_batches)
);`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function connectionEnvironment(rawUrl) {
  const url = new URL(rawUrl);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol), "database URL must use PostgreSQL");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  assert.ok(database, "database URL must include a database name");
  return {
    database,
    env: {
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGDATABASE: database,
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGSSLMODE: url.searchParams.get("sslmode") || "require"
    }
  };
}

export function identityFingerprint(identity) {
  return sha256([
    identity.systemIdentifier,
    identity.serverAddress,
    identity.serverPort,
    identity.databaseOid,
    identity.database
  ].join("|"));
}

function clusterFingerprint(identity) {
  return sha256([identity.systemIdentifier, identity.serverAddress, identity.serverPort].join("|"));
}

export function validateRestoreGuard({
  source,
  target,
  targetConfirmation,
  targetMarkerToken,
  allowedTargetFingerprints,
  protectedFingerprints
}) {
  assert.match(target.database, /(?:^|_)restore(?:_|$)/i, "target database name must include restore");
  assert.equal(targetConfirmation, target.database, "typed target confirmation does not match");
  assert.notEqual(clusterFingerprint(source), clusterFingerprint(target), "source and target must be on different database clusters");
  assert.notEqual(identityFingerprint(source), identityFingerprint(target), "source and target database identities match");
  assert.equal(Number(target.markerCount), 1, "target must contain exactly one restore guard marker");
  assert.equal(target.markerDatabase, target.database, "restore guard marker database does not match");
  assert.equal(target.markerDigest, sha256(targetMarkerToken), "restore guard marker token does not match");
  assert.equal(Number(target.nonGuardRelations), 0, "target database is not empty");

  const targetFingerprint = identityFingerprint(target);
  assert.ok(allowedTargetFingerprints.has(targetFingerprint), "target identity is not in the disposable allowlist");
  assert.ok(!protectedFingerprints.has(targetFingerprint), "target identity is protected");
  assert.ok(!protectedFingerprints.has(clusterFingerprint(target)), "target cluster is protected");
  return { targetFingerprint, sourceFingerprint: identityFingerprint(source) };
}

function spawnCaptured(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"] });
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    if (options.input) child.stdin.end(options.input);
    child.on("error", () => reject(new Error("RESTORE_TOOL_UNAVAILABLE")));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error("RESTORE_TOOL_FAILED"));
      else resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}

async function inspectDatabase(connection, runner = spawnCaptured) {
  const output = await runner("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", identitySql], {
    env: { ...process.env, ...connection.env }
  });
  try {
    const identity = JSON.parse(output);
    if (!identity.markerExists) {
      return { ...identity, markerCount: 0, markerDatabase: null, markerDigest: null };
    }
    const markerOutput = await runner("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", markerSql], {
      env: { ...process.env, ...connection.env }
    });
    return { ...identity, ...JSON.parse(markerOutput) };
  } catch {
    throw new Error("RESTORE_IDENTITY_INVALID");
  }
}

function parseVersion(output) {
  const match = String(output).match(/(\d+)(?:\.\d+)?/);
  if (!match) throw new Error("RESTORE_CLIENT_VERSION_UNKNOWN");
  return Number(match[1]);
}

function waitForChild(child, errorCode) {
  return new Promise((resolve, reject) => {
    child.on("error", () => reject(new Error(errorCode)));
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(errorCode)));
  });
}

async function encryptedDump({ sourceConnection, artifactPath, ageRecipient }) {
  const dump = spawn("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--exclude-schema=kapchi_restore_guard"], {
    env: { ...process.env, ...sourceConnection.env },
    stdio: ["ignore", "pipe", "ignore"]
  });
  const age = spawn("age", ["--recipient", ageRecipient], { stdio: ["pipe", "pipe", "ignore"] });
  const output = createWriteStream(artifactPath, { flags: "wx", mode: 0o600 });
  try {
    await Promise.all([
      pipeline(dump.stdout, age.stdin),
      pipeline(age.stdout, output),
      waitForChild(dump, "RESTORE_DUMP_FAILED"),
      waitForChild(age, "RESTORE_ENCRYPTION_FAILED")
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("RESTORE_")) throw error;
    throw new Error("RESTORE_ARTIFACT_WRITE_FAILED");
  }
  await chmod(artifactPath, 0o600);
}

async function encryptedRestore({ targetConnection, artifactPath, ageIdentityFile }) {
  const decrypt = spawn("age", ["--decrypt", "--identity", ageIdentityFile, artifactPath], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  const restore = spawn("pg_restore", [
    "--exit-on-error",
    "--single-transaction",
    "--no-owner",
    "--no-acl",
    `--dbname=${targetConnection.database}`
  ], {
    env: { ...process.env, ...targetConnection.env },
    stdio: ["pipe", "ignore", "ignore"]
  });
  decrypt.stdout.pipe(restore.stdin);
  await Promise.all([
    waitForChild(decrypt, "RESTORE_DECRYPTION_FAILED"),
    waitForChild(restore, "RESTORE_APPLY_FAILED")
  ]);
}

async function fileDigest(filePath) {
  return sha256(await readFile(filePath));
}

function requiredEnvironment(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`RESTORE_ENV_REQUIRED:${name}`);
  return value;
}

function parseSet(value) {
  return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
}

export async function runRestoreDrill({ env = process.env, runner = spawnCaptured, performRestore = true } = {}) {
  const startedAt = Date.now();
  const releaseSha = requiredEnvironment(env, "RELEASE_SHA");
  assert.match(releaseSha, /^[0-9a-f]{40}$/i, "RESTORE_RELEASE_SHA_INVALID");
  const sourceConnection = connectionEnvironment(requiredEnvironment(env, "RESTORE_SOURCE_DATABASE_URL"));
  const targetConnection = connectionEnvironment(requiredEnvironment(env, "RESTORE_TARGET_DATABASE_URL"));
  const source = await inspectDatabase(sourceConnection, runner);
  const target = await inspectDatabase(targetConnection, runner);
  const guard = validateRestoreGuard({
    source,
    target,
    targetConfirmation: requiredEnvironment(env, "RESTORE_TARGET_CONFIRM_DATABASE"),
    targetMarkerToken: requiredEnvironment(env, "RESTORE_TARGET_MARKER_TOKEN"),
    allowedTargetFingerprints: parseSet(requiredEnvironment(env, "RESTORE_TARGET_ALLOWLIST")),
    protectedFingerprints: parseSet(requiredEnvironment(env, "RESTORE_PROTECTED_IDENTITIES"))
  });

  if (!performRestore) {
    return {
      event: "restore.drill.guard.passed",
      releaseSha,
      checkedAt: new Date().toISOString(),
      sourceIdentityHash: guard.sourceFingerprint,
      targetIdentityHash: guard.targetFingerprint
    };
  }

  const artifactPath = path.resolve(requiredEnvironment(env, "RESTORE_ENCRYPTED_ARTIFACT_PATH"));
  assert.ok(artifactPath.endsWith(".age"), "RESTORE_ARTIFACT_MUST_USE_AGE_EXTENSION");
  const ageRecipient = requiredEnvironment(env, "RESTORE_AGE_RECIPIENT");
  const ageIdentityFile = path.resolve(requiredEnvironment(env, "RESTORE_AGE_IDENTITY_FILE"));
  const pgDumpVersion = parseVersion(await runner("pg_dump", ["--version"]));
  const serverMajor = Math.floor(Number(source.serverVersionNum) / 10000);
  assert.equal(pgDumpVersion, serverMajor, "RESTORE_POSTGRES_MAJOR_VERSION_MISMATCH");

  await encryptedDump({ sourceConnection, artifactPath, ageRecipient });
  const encryptedSha256 = await fileDigest(artifactPath);
  const artifactStat = await stat(artifactPath);
  assert.equal(artifactStat.mode & 0o077, 0, "RESTORE_ARTIFACT_PERMISSIONS_TOO_OPEN");
  await encryptedRestore({ targetConnection, artifactPath, ageIdentityFile });

  const migrationCommand = env.RESTORE_MIGRATION_COMMAND ?? "backend/dist/database/migrate.js";
  await runner(process.execPath, [migrationCommand, "check"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: requiredEnvironment(env, "RESTORE_TARGET_DATABASE_URL"),
      DATABASE_DIRECT_URL: requiredEnvironment(env, "RESTORE_TARGET_DATABASE_URL")
    }
  });
  const counts = JSON.parse(await runner("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", integritySql], {
    env: { ...process.env, ...targetConnection.env }
  }));

  return {
    event: "restore.drill.completed",
    releaseSha,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    encryptedArtifactSha256: encryptedSha256,
    migrationState: "current",
    counts,
    providerCallsExecuted: false,
    workersExecuted: false,
    passed: true
  };
}

async function main() {
  const command = process.argv[2];
  if (command === "fingerprint") {
    const sourceConnection = connectionEnvironment(requiredEnvironment(process.env, "RESTORE_SOURCE_DATABASE_URL"));
    const targetConnection = connectionEnvironment(requiredEnvironment(process.env, "RESTORE_TARGET_DATABASE_URL"));
    const source = await inspectDatabase(sourceConnection);
    const target = await inspectDatabase(targetConnection);
    console.log(JSON.stringify({
      event: "restore.drill.identities.fingerprinted",
      sourceIdentityHash: identityFingerprint(source),
      sourceClusterHash: clusterFingerprint(source),
      targetIdentityHash: identityFingerprint(target),
      targetClusterHash: clusterFingerprint(target)
    }));
    return;
  }
  if (!["guard", "run"].includes(command)) throw new Error("RESTORE_COMMAND_INVALID");
  const result = await runRestoreDrill({ performRestore: command === "run" });
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const reason = error instanceof Error ? error.message.split(":")[0] : "RESTORE_DRILL_FAILED";
    console.error(JSON.stringify({ event: "restore.drill.failed", errorCode: reason }));
    process.exitCode = 1;
  });
}
