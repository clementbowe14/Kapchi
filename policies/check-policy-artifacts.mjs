import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputs = [
  join(root, "client", "content", "generated-policy-manifest.ts"),
  join(root, "backend", "src", "modules", "policies", "generated-policy-manifest.ts"),
];
const before = await Promise.all(outputs.map((file) => readFile(file, "utf8").catch(() => null)));
const generated = spawnSync(process.execPath, [join(root, "policies", "generate-policy-artifacts.mjs")], { stdio: "inherit" });
if (generated.status !== 0) process.exit(generated.status ?? 1);
const after = await Promise.all(outputs.map((file) => readFile(file, "utf8")));
if (before.some((value, index) => value !== after[index])) {
  console.error("Generated policy artifacts are stale. Run node policies/generate-policy-artifacts.mjs and commit the results.");
  process.exit(1);
}
console.log("Policy artifacts are deterministic and current.");
