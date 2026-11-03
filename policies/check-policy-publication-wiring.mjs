import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = await readFile(
  join(root, ".github", "workflows", "policy-artifacts.yml"),
  "utf8",
);
const clientPackage = JSON.parse(
  await readFile(join(root, "client", "package.json"), "utf8"),
);

if (
  !workflow.includes(
    "Production publication guard (drafts intentionally fail until owner approval)",
  ) ||
  !workflow.includes("run: node policies/validate-policy-publication.mjs")
) {
  throw new Error(
    "The policy workflow must expose and invoke the production publication guard.",
  );
}

if (
  clientPackage.scripts?.prebuild !==
  "node ../policies/validate-policy-build.mjs"
) {
  throw new Error(
    "The client prebuild must invoke the environment-aware policy publication guard.",
  );
}

const preview = spawnSync(
  process.execPath,
  [join(root, "policies", "validate-policy-build.mjs")],
  {
    encoding: "utf8",
    env: { ...process.env, VERCEL_ENV: "preview" },
  },
);
if (preview.status !== 0) {
  throw new Error("Preview builds must not be blocked by draft policy content.");
}

const { bundleVersion } = JSON.parse(
  await readFile(join(root, "policies", "active.json"), "utf8"),
);
const release = JSON.parse(
  await readFile(
    join(root, "policies", "archive", `${bundleVersion}.json`),
    "utf8",
  ),
);
const production = spawnSync(
  process.execPath,
  [join(root, "policies", "validate-policy-build.mjs")],
  {
    encoding: "utf8",
    env: { ...process.env, VERCEL_ENV: "production" },
  },
);

if (release.publicationStatus === "draft" && production.status === 0) {
  throw new Error("A production build accepted a draft policy bundle.");
}
if (release.publicationStatus === "approved" && production.status !== 0) {
  throw new Error(
    `An approved policy bundle failed publication validation:\n${production.stderr}`,
  );
}

console.log(
  "Policy publication wiring preserves previews and fails closed for production.",
);
