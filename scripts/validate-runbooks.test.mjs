import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateRunbooks } from "./validate-runbooks.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("runbook set covers environment, launch, recovery, alerts, and evidence", async () => {
  const result = await validateRunbooks(path.join(root, "docs/runbooks"));
  assert.equal(result.runbookCount, 6);
});
