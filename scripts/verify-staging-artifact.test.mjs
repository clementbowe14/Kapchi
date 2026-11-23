import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { digestArtifactContents, digestBundledArtifact, verifyDownloadedArtifact } from "./verify-staging-artifact.mjs";

test("recomputes archive and deterministic extracted-content digests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kapchi-artifact-"));
  const contents = path.join(root, "contents");
  await mkdir(path.join(contents, "receipts"), { recursive: true });
  await writeFile(path.join(root, "artifact.zip"), "archive bytes");
  await writeFile(path.join(contents, "report.json"), "{}\n");
  await writeFile(path.join(contents, "receipts", "one.json"), "{\"ok\":true}\n");
  const candidateSha = "a".repeat(40);
  const metadata = { id: 42, name: `staging-candidate-${candidateSha}-1`, expired: false, workflow_run: { id: 99, head_sha: candidateSha } };
  const first = await verifyDownloadedArtifact({ archivePath: path.join(root, "artifact.zip"), contentsDirectory: contents, metadata, candidateSha, expectedRunId: 99, expectedRunAttempt: 1, expectedName: metadata.name });
  assert.deepEqual(
    await digestBundledArtifact({ archivePath: path.join(root, "artifact.zip"), contentsDirectory: contents }),
    {
      archiveBytes: first.archiveBytes,
      archiveSha256: first.archiveSha256,
      contentSha256: first.contentSha256,
      files: first.files
    },
  );
  assert.equal(first.contentSha256, (await digestArtifactContents(contents)).sha256);
  await writeFile(path.join(contents, "report.json"), "{\"changed\":true}\n");
  const second = await digestArtifactContents(contents);
  assert.notEqual(second.sha256, first.contentSha256);
});

test("rejects artifact metadata from a different run or candidate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kapchi-artifact-"));
  await mkdir(path.join(root, "contents"));
  await writeFile(path.join(root, "artifact.zip"), "archive");
  await writeFile(path.join(root, "contents", "report.json"), "{}");
  const candidateSha = "a".repeat(40);
  await assert.rejects(
    verifyDownloadedArtifact({ archivePath: path.join(root, "artifact.zip"), contentsDirectory: path.join(root, "contents"), metadata: { id: 1, name: "expected", expired: false, workflow_run: { id: 2, head_sha: "b".repeat(40) } }, candidateSha, expectedRunId: 2, expectedRunAttempt: 1, expectedName: "expected" }),
    /candidate SHA differs/
  );
});
