import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exampleFiles = ["backend/.env.example", "client/.env.example"];
const sensitiveName = /(?:SECRET|TOKEN|PASSWORD|PUBLISHABLE_KEY)/;
const connectionName = /(?:DATABASE_(?:DIRECT_)?URL|REDIS_URL)/;

function activeAssignments(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return [];
    const separator = trimmed.indexOf("=");
    return [[trimmed.slice(0, separator), trimmed.slice(separator + 1)]];
  });
}

for (const relativePath of exampleFiles) {
  test(`${relativePath} contains placeholders, never credential-shaped examples`, async () => {
    const assignments = activeAssignments(await readFile(path.join(root, relativePath), "utf8"));
    for (const [name, value] of assignments) {
      if (sensitiveName.test(name)) {
        assert.match(value, /^replace_me_[a-z0-9_]+$/, `${name} must use an explicit replace_me placeholder`);
      }
      if (connectionName.test(name)) {
        const url = new URL(value);
        assert.equal(url.username, "", `${name} must not include a username`);
        assert.equal(url.password, "", `${name} must not include a password`);
      }
    }
  });
}
