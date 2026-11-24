import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  loadMainRuleset,
  validateLiveMainRuleset,
  validateMainRulesetContract
} from "./github-governance.mjs";

const contract = JSON.parse(await readFile(new URL("../deploy/github-main-ruleset.json", import.meta.url)));
const workflow = await readFile(new URL("../.github/workflows/repository-governance.yml", import.meta.url), "utf8");

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function liveRuleset(overrides = {}) {
  return {
    id: 42,
    source_type: "Repository",
    ...structuredClone(contract),
    ...overrides
  };
}

test("defines an active, no-bypass main ruleset with trusted review", () => {
  assert.equal(validateMainRulesetContract(contract), contract);
});

test("keeps the governance audit secretless and pinned to reviewed actions", () => {
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node scripts\/github-governance\.mjs validate-live/);
  assert.doesNotMatch(workflow, /pull_request(?:_target)?:/);
  assert.doesNotMatch(workflow, /secrets\.|GITHUB_TOKEN|authorization/i);
  for (const action of workflow.matchAll(/uses:\s*([^\s#]+)/g)) {
    assert.match(action[1], /^[^@]+@[0-9a-f]{40}$/);
  }
});

test("rejects weakened approval and branch-integrity settings", () => {
  const mutations = [
    (ruleset) => { ruleset.enforcement = "disabled"; },
    (ruleset) => { ruleset.bypass_actors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }]; },
    (ruleset) => { ruleset.conditions.ref_name.include = ["refs/heads/develop"]; },
    (ruleset) => { ruleset.rules = ruleset.rules.filter(({ type }) => type !== "non_fast_forward"); },
    (ruleset) => { ruleset.rules.find(({ type }) => type === "pull_request").parameters.required_approving_review_count = 0; },
    (ruleset) => { ruleset.rules.find(({ type }) => type === "pull_request").parameters.dismiss_stale_reviews_on_push = false; },
    (ruleset) => { ruleset.rules.find(({ type }) => type === "pull_request").parameters.require_code_owner_review = true; },
    (ruleset) => { ruleset.rules.find(({ type }) => type === "pull_request").parameters.require_last_push_approval = false; },
    (ruleset) => { ruleset.rules.find(({ type }) => type === "pull_request").parameters.required_review_thread_resolution = false; }
  ];

  for (const mutate of mutations) {
    const weakened = structuredClone(contract);
    mutate(weakened);
    assert.throws(() => validateMainRulesetContract(weakened));
  }
});

test("loads one repository-owned ruleset and validates its live settings", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ options, url });
    if (url.endsWith("/rulesets?includes_parents=false")) {
      return response([{ id: 42, name: contract.name, source_type: "Repository" }]);
    }
    return response(liveRuleset());
  };

  const result = await validateLiveMainRuleset({ repository: "clementbowe14/Kapchi", fetchImpl });

  assert.deepEqual(result, {
    enforcement: "active",
    name: contract.name,
    rulesetId: 42,
    target: "refs/heads/main"
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ options }) => !Object.hasOwn(options.headers, "authorization")));
});

test("fails closed on missing, duplicate, inherited, or unreadable rulesets", async () => {
  const cases = [
    async () => response([]),
    async () => response([
      { id: 1, name: contract.name, source_type: "Repository" },
      { id: 2, name: contract.name, source_type: "Repository" }
    ]),
    async () => response([{ id: 1, name: contract.name, source_type: "Organization" }]),
    async () => response({ message: "forbidden" }, 403)
  ];

  for (const fetchImpl of cases) {
    await assert.rejects(() => loadMainRuleset({ repository: "clementbowe14/Kapchi", fetchImpl }));
  }
});

test("rejects a malformed repository identifier before making a request", async () => {
  await assert.rejects(
    () => loadMainRuleset({ repository: "not-a-repository", fetchImpl: async () => response([]) }),
    /OWNER\/REPO/
  );
});
