#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const API_VERSION = "2026-03-10";
const RULESET_NAME = "Protect main with trusted review";
const MAIN_REF = "refs/heads/main";

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys do not match the contract`);
}

function ruleByType(ruleset, type) {
  assert.ok(Array.isArray(ruleset.rules), "ruleset rules must be an array");
  const matches = ruleset.rules.filter((rule) => rule?.type === type);
  assert.equal(matches.length, 1, `ruleset must contain exactly one ${type} rule`);
  return matches[0];
}

export function validateMainRulesetContract(ruleset, { requireVisibleBypassActors = true } = {}) {
  assert.equal(ruleset.name, RULESET_NAME, "ruleset name is invalid");
  assert.equal(ruleset.target, "branch", "ruleset must target branches");
  assert.equal(ruleset.enforcement, "active", "ruleset enforcement must be active");

  if (requireVisibleBypassActors || Object.hasOwn(ruleset, "bypass_actors")) {
    assert.deepEqual(ruleset.bypass_actors, [], "ruleset must not allow bypass actors");
  }

  exactKeys(ruleset.conditions, ["ref_name"], "ruleset conditions");
  exactKeys(ruleset.conditions.ref_name, ["include", "exclude"], "ruleset ref condition");
  assert.deepEqual(ruleset.conditions.ref_name.include, [MAIN_REF], "ruleset must protect only main");
  assert.deepEqual(ruleset.conditions.ref_name.exclude, [], "ruleset must not exclude refs");
  assert.deepEqual(
    ruleset.rules.map(({ type }) => type).sort(),
    ["deletion", "non_fast_forward", "pull_request"],
    "ruleset rule inventory differs from the reviewed contract"
  );

  ruleByType(ruleset, "deletion");
  ruleByType(ruleset, "non_fast_forward");
  const pullRequest = ruleByType(ruleset, "pull_request");
  const parameters = pullRequest.parameters;
  assert.ok(parameters && typeof parameters === "object", "pull request rule parameters are required");
  assert.equal(parameters.required_approving_review_count, 1, "main must require one approval");
  assert.equal(parameters.dismiss_stale_reviews_on_push, true, "new pushes must dismiss stale approvals");
  assert.equal(parameters.require_code_owner_review, false, "approval may come from any trusted write-level reviewer");
  assert.equal(parameters.require_last_push_approval, true, "the latest push must be approved by another trusted reviewer");
  assert.equal(parameters.required_review_thread_resolution, true, "review threads must be resolved");
  assert.equal(parameters.require_extra_approval_for_unattributed_changes, true, "unattributed automated changes require an extra human approval");
  assert.deepEqual(
    [...parameters.allowed_merge_methods].sort(),
    ["merge", "rebase", "squash"],
    "ruleset must preserve the repository merge methods"
  );
  return ruleset;
}

export async function loadMainRuleset({ repository, fetchImpl = fetch }) {
  assert.match(repository ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "repository must be OWNER/REPO");
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "kapchi-repository-governance",
    "x-github-api-version": API_VERSION
  };
  const listResponse = await fetchImpl(`https://api.github.com/repos/${repository}/rulesets?includes_parents=false`, { headers });
  if (!listResponse.ok) throw new Error(`GitHub ruleset list failed with status ${listResponse.status}`);
  const summaries = await listResponse.json();
  assert.ok(Array.isArray(summaries), "GitHub ruleset list must be an array");
  const matches = summaries.filter((ruleset) => ruleset.name === RULESET_NAME && ruleset.source_type === "Repository");
  assert.equal(matches.length, 1, `expected one active repository ruleset named ${RULESET_NAME}`);

  const detailResponse = await fetchImpl(`https://api.github.com/repos/${repository}/rulesets/${matches[0].id}`, { headers });
  if (!detailResponse.ok) throw new Error(`GitHub ruleset detail failed with status ${detailResponse.status}`);
  return detailResponse.json();
}

export async function validateLiveMainRuleset(options) {
  const ruleset = await loadMainRuleset(options);
  validateMainRulesetContract(ruleset, { requireVisibleBypassActors: false });
  return {
    enforcement: ruleset.enforcement,
    name: ruleset.name,
    rulesetId: ruleset.id,
    target: MAIN_REF
  };
}

function argumentValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0 || !argv[index + 1]) throw new Error(`Use ${flag} <value>`);
  return argv[index + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === "validate-contract") {
    const file = path.resolve(argumentValue(argv, "--ruleset"));
    const ruleset = JSON.parse(await readFile(file, "utf8"));
    validateMainRulesetContract(ruleset);
    console.info(JSON.stringify({ event: "github.governance.contract.validated", name: ruleset.name }));
    return;
  }
  if (command === "validate-live") {
    const result = await validateLiveMainRuleset({ repository: argumentValue(argv, "--repository") });
    console.info(JSON.stringify({ event: "github.governance.live.validated", ...result }));
    return;
  }
  throw new Error("Use validate-contract or validate-live");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: "github.governance.validation.failed",
      errorCode: "GITHUB_GOVERNANCE_INVALID",
      reason: error instanceof Error ? error.message : "Unknown governance validation failure"
    }));
    process.exitCode = 1;
  });
}
