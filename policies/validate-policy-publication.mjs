import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const policyRoot = join(root, "policies");
const { bundleVersion } = JSON.parse(await readFile(join(policyRoot, "active.json"), "utf8"));
const release = JSON.parse(await readFile(join(policyRoot, "archive", `${bundleVersion}.json`), "utf8"));
const approvalFiles = (await readdir(join(policyRoot, "approvals")))
  .filter((name) => name.endsWith(".json") && !name.endsWith(".example.json") && name !== "schema.json");
const approval = approvalFiles.includes(`${bundleVersion}.json`)
  ? JSON.parse(await readFile(join(policyRoot, "approvals", `${bundleVersion}.json`), "utf8"))
  : null;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

if (release.publicationStatus !== "approved" || !approval) {
  console.error(`Policy bundle ${bundleVersion} is draft-only. Add an explicit owner approval record before production publication.`);
  process.exit(1);
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
if (
  approval.schemaVersion !== 1 ||
  approval.bundleVersion !== bundleVersion ||
  typeof approval.approver !== "string" ||
  !approval.approver.trim() ||
  !Array.isArray(approval.scope) ||
  !approval.scope.includes("owner") ||
  !datePattern.test(approval.approvalDate) ||
  !datePattern.test(approval.activationDate) ||
  approval.activationDate < approval.approvalDate ||
  release.effectiveDate < approval.approvalDate ||
  release.effectiveDate < approval.activationDate
) {
  throw new Error(`Approval record for ${bundleVersion} is invalid or attempts retroactive activation.`);
}

const statementDigest = digest(release.checkoutStatement.text);
const documentEvidence = release.documents.map((document) => ({
  key: document.key,
  version: document.version,
  digest: digest({
    key: document.key,
    role: document.role,
    sections: document.sections,
    summary: document.summary,
    title: document.title,
    version: document.version,
  }),
}));
if (
  approval.checkoutStatement?.version !== release.checkoutStatement.version ||
  approval.checkoutStatement?.digest !== statementDigest ||
  JSON.stringify(approval.documents) !== JSON.stringify(documentEvidence)
) {
  throw new Error(`Approval record for ${bundleVersion} does not match the generated versions and digests.`);
}

console.log(`Policy bundle ${bundleVersion} has an owner approval record and is eligible for publication.`);
