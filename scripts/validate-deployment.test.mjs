import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateBackendDockerfile, validateDeploymentTemplate } from "./validate-deployment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("DigitalOcean template is digest-pinned and contains all execution components", async () => {
  const text = await readFile(path.join(root, "deploy/digitalocean.backend.template.yaml"), "utf8");
  assert.equal(validateDeploymentTemplate(text).componentCount, 4);
});

test("backend image is non-root and carries compiled migration assets", async () => {
  const text = await readFile(path.join(root, "backend/Dockerfile"), "utf8");
  assert.deepEqual(validateBackendDockerfile(text), { runtimeUser: "node", port: 4000 });
});

test("template validator rejects real-looking credentials", () => {
  const fakeCredential = ["sk", "live", "synthetic_validation_value"].join("_");
  assert.throws(() => validateDeploymentTemplate(fakeCredential), /secret-like value/);
});
