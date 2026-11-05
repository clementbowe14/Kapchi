import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAlertInventory } from "./validate-alerts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("repository alert inventory contains every required query contract", async () => {
  const result = await validateAlertInventory({
    inventoryPath: path.join(root, "deploy/alerts/inventory.json"),
    rootDirectory: root
  });
  assert.equal(result.alertCount, 7);
});

test("production evidence mode rejects repository placeholders", async () => {
  await assert.rejects(
    validateAlertInventory({
      inventoryPath: path.join(root, "deploy/alerts/inventory.json"),
      requireEvidence: true,
      rootDirectory: root
    }),
    /placeholder/,
  );
});
