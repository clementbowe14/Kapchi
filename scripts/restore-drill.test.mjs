import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { connectionEnvironment, identityFingerprint, runRestoreDrill, validateRestoreGuard } from "./restore-drill.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function databaseUrl({ database, host, user }) {
  const url = new URL(`postgresql://${host}/${database}`);
  url.username = user;
  url.password = "synthetic-password";
  return url.toString();
}

const source = {
  database: "kapchi_production",
  databaseOid: "100",
  serverAddress: "10.0.0.1",
  serverPort: 25060,
  systemIdentifier: "cluster-source",
  serverVersionNum: "160006",
  currentUser: "source_reader",
  markerExists: false,
  markerCount: 0,
  nonGuardRelations: 40
};
const target = {
  database: "kapchi_issue114_restore",
  databaseOid: "200",
  serverAddress: "10.0.0.2",
  serverPort: 25060,
  systemIdentifier: "cluster-target",
  serverVersionNum: "160006",
  currentUser: "restore_operator",
  markerExists: true,
  markerCount: 1,
  markerDatabase: "kapchi_issue114_restore",
  markerDigest: digest("marker-token"),
  nonGuardRelations: 0
};

function validGuard(overrides = {}) {
  return {
    source,
    target,
    targetConfirmation: target.database,
    targetMarkerToken: "marker-token",
    allowedTargetFingerprints: new Set([identityFingerprint(target)]),
    protectedFingerprints: new Set([identityFingerprint(source)]),
    ...overrides
  };
}

test("keeps database credentials out of connection arguments", () => {
  const rawUrl = new URL(databaseUrl({ database: "kapchi_restore", host: "db.example.test:5432", user: "restore_user" }));
  rawUrl.searchParams.set("sslmode", "verify-full");
  const connection = connectionEnvironment(rawUrl.toString());
  assert.equal(connection.database, "kapchi_restore");
  assert.equal(connection.env.PGPASSWORD, "synthetic-password");
  assert.equal(connection.env.PGSSLMODE, "verify-full");
});

test("accepts a distinct, marked, empty, allowlisted restore target", () => {
  assert.equal(validateRestoreGuard(validGuard()).targetFingerprint, identityFingerprint(target));
});

test("rejects URL aliases that reach the source cluster", () => {
  const aliasedTarget = { ...target, systemIdentifier: source.systemIdentifier, serverAddress: source.serverAddress };
  assert.throws(() => validateRestoreGuard(validGuard({
    target: aliasedTarget,
    allowedTargetFingerprints: new Set([identityFingerprint(aliasedTarget)])
  })), /different database clusters/);
});

test("rejects missing marker, dirty target, confirmation mismatch, and protected identity", () => {
  assert.throws(() => validateRestoreGuard(validGuard({ target: { ...target, markerCount: 0 } })), /exactly one/);
  assert.throws(() => validateRestoreGuard(validGuard({ target: { ...target, nonGuardRelations: 1 } })), /not empty/);
  assert.throws(() => validateRestoreGuard(validGuard({ targetConfirmation: "wrong_restore" })), /confirmation/);
  assert.throws(() => validateRestoreGuard(validGuard({ protectedFingerprints: new Set([identityFingerprint(target)]) })), /protected/);
});

test("guard mode emits hashes only and never connection coordinates", async () => {
  const responses = [
    JSON.stringify(source),
    JSON.stringify({ ...target, markerCount: undefined, markerDatabase: undefined, markerDigest: undefined }),
    JSON.stringify({ markerCount: target.markerCount, markerDatabase: target.markerDatabase, markerDigest: target.markerDigest })
  ];
  const env = {
    RELEASE_SHA: "a".repeat(40),
    RESTORE_SOURCE_DATABASE_URL: databaseUrl({ database: "kapchi_production", host: "source.internal", user: "source_reader" }),
    RESTORE_TARGET_DATABASE_URL: databaseUrl({ database: "kapchi_issue114_restore", host: "target.internal", user: "restore_operator" }),
    RESTORE_TARGET_CONFIRM_DATABASE: target.database,
    RESTORE_TARGET_MARKER_TOKEN: "marker-token",
    RESTORE_TARGET_ALLOWLIST: identityFingerprint(target),
    RESTORE_PROTECTED_IDENTITIES: identityFingerprint(source)
  };
  const result = await runRestoreDrill({ env, performRestore: false, runner: async () => responses.shift() });
  const serialized = JSON.stringify(result);
  assert.equal(result.event, "restore.drill.guard.passed");
  assert.ok(!serialized.includes("source.internal"));
  assert.ok(!serialized.includes("target.internal"));
  assert.ok(!serialized.includes("synthetic-password"));
});
