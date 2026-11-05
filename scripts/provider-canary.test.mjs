import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCanaryRequest, validateContractFile } from "./provider-canary.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const document = JSON.parse(await readFile(path.join(root, "deploy/provider-canaries.json"), "utf8"));

test("canary contract covers every approved provider boundary", () => {
  assert.equal(validateContractFile(document).contractCount, 4);
});

test("canary planner requires exact confirmation and release identity", () => {
  const contract = document.contracts.find((item) => item.provider === "stripe");
  const env = Object.fromEntries(contract.requiredEnvironment.map((name) => [name, "configured"]));
  env.PRODUCTION_API_URL = "https://api.kapchi.test";
  const result = validateCanaryRequest({
    contracts: document.contracts,
    provider: "stripe",
    releaseSha: "a".repeat(40),
    confirmation: contract.confirmation,
    env
  });
  assert.equal(result.executionStatus, "blocked-until-runtime-canary-contract-is-available");
  assert.throws(() => validateCanaryRequest({
    contracts: document.contracts,
    provider: "stripe",
    releaseSha: "a".repeat(40),
    confirmation: "yes",
    env
  }), /CANARY_CONFIRMATION_INVALID/);
});

test("canary planner rejects arbitrary or local targets", () => {
  const contract = document.contracts.find((item) => item.provider === "blob");
  const env = Object.fromEntries(contract.requiredEnvironment.map((name) => [name, "configured"]));
  env.PRODUCTION_API_URL = "http://localhost:4000";
  assert.throws(() => validateCanaryRequest({
    contracts: document.contracts,
    provider: "blob",
    releaseSha: "a".repeat(40),
    confirmation: contract.confirmation,
    env
  }), /CANARY_API_MUST_USE_HTTPS/);
});
