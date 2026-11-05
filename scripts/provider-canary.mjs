#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith("--") || !value) throw new Error("CANARY_ARGUMENT_INVALID");
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

export function validateCanaryRequest({ contracts, provider, releaseSha, confirmation, env }) {
  assert.match(releaseSha ?? "", /^[0-9a-f]{40}$/i, "CANARY_RELEASE_SHA_INVALID");
  const contract = contracts.find((candidate) => candidate.provider === provider);
  assert.ok(contract, "CANARY_PROVIDER_INVALID");
  assert.equal(confirmation, contract.confirmation, "CANARY_CONFIRMATION_INVALID");
  for (const name of contract.requiredEnvironment) {
    assert.ok(String(env[name] ?? "").trim(), `CANARY_ENV_REQUIRED:${name}`);
  }
  const apiUrl = new URL(env.PRODUCTION_API_URL);
  assert.equal(apiUrl.protocol, "https:", "CANARY_API_MUST_USE_HTTPS");
  assert.ok(!/localhost|127\.0\.0\.1|\.invalid$/i.test(apiUrl.hostname), "CANARY_API_MUST_BE_PRODUCTION_ROUTABLE");
  return {
    event: "provider.canary.plan.validated",
    provider,
    releaseSha,
    allowedMutation: contract.allowedMutation,
    cleanup: contract.cleanup,
    evidenceFields: contract.evidenceFields,
    automation: contract.automation,
    executionStatus: "blocked-until-runtime-canary-contract-is-available"
  };
}

async function loadContracts() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return JSON.parse(await readFile(path.join(root, "deploy/provider-canaries.json"), "utf8"));
}

export function validateContractFile(document) {
  assert.equal(document.schemaVersion, 1, "CANARY_SCHEMA_INVALID");
  assert.deepEqual(document.contracts.map((item) => item.provider).sort(), ["blob", "clerk", "messaging", "stripe"]);
  for (const contract of document.contracts) {
    assert.match(contract.confirmation, /^I_CONFIRM_KAPCHI_[A-Z]+_CANARY$/);
    assert.ok(contract.requiredEnvironment.includes("PRODUCTION_API_URL"));
    assert.ok(contract.evidenceFields.length > 0);
    assert.ok(contract.cleanup);
    assert.match(contract.automation, /^requires-runtime-/);
  }
  return { contractCount: document.contracts.length };
}

async function main() {
  const command = process.argv[2];
  const document = await loadContracts();
  if (command === "validate-contracts") {
    console.log(JSON.stringify({ event: "provider.canary.contracts.validated", ...validateContractFile(document) }));
    return;
  }
  if (command !== "plan") throw new Error("CANARY_COMMAND_INVALID");
  const args = parseArgs(process.argv.slice(3));
  const result = validateCanaryRequest({
    contracts: document.contracts,
    provider: args.provider,
    releaseSha: args["release-sha"],
    confirmation: args.confirm,
    env: process.env
  });
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "provider.canary.failed", errorCode: String(error.message).split(":")[0] }));
    process.exitCode = 1;
  });
}
