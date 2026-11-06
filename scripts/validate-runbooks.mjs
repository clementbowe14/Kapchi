#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const required = {
  "production-environment.md": ["Production Environment Ownership", "CLERK_JWT_AUDIENCE", "DATABASE_DIRECT_URL", "MESSAGE_CANARY_DESTINATION"],
  "production-launch.md": ["Build One Immutable Release", "Migrate And Deploy Backend Components", "Execute Provider Canaries", "Observe And Decide"],
  "production-backup-restore.md": ["Disposable Target Preparation", "restore-drill.mjs guard", "No plaintext dump is written", "Never automate database deletion"],
  "production-rollback.md": ["Compatibility Gate", "Application Rollback", "Roll Forward And Write Freeze"],
  "production-alerts.md": ["Better Stack", "Vercel Functions And Cron", "Public Readiness", "Deployment And Migration"],
  "acceptance-evidence.md": ["Repository proof", "Production proof", "Issue 114 remains open"]
};

export async function validateRunbooks(directory) {
  for (const [fileName, fragments] of Object.entries(required)) {
    const text = await readFile(path.join(directory, fileName), "utf8");
    for (const fragment of fragments) {
      assert.ok(text.includes(fragment), `${fileName} is missing ${fragment}`);
    }
    assert.ok(!/(?:sk_live_|whsec_|postgres(?:ql)?:\/\/[^\s]+:[^\s]+@)/.test(text), `${fileName} contains a secret-like value`);
  }
  return { runbookCount: Object.keys(required).length };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await validateRunbooks(path.join(root, "docs/runbooks"));
  console.log(JSON.stringify({ event: "runbooks.validated", ...result }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "runbooks.invalid", errorCode: "RUNBOOK_INVALID", reason: error.message }));
    process.exitCode = 1;
  });
}
