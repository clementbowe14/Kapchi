#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const GIT_SHA = /^[0-9a-f]{40}$/;

async function filesBelow(directory, current = directory) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`artifact contents must not contain symbolic links: ${entry.name}`);
    if (entry.isDirectory()) files.push(...await filesBelow(directory, absolute));
    else if (entry.isFile()) files.push(path.relative(directory, absolute).split(path.sep).join("/"));
    else throw new Error(`artifact contains an unsupported entry: ${entry.name}`);
  }
  return files;
}

export async function digestArtifactContents(directory) {
  const root = path.resolve(directory);
  const files = await filesBelow(root);
  assert.ok(files.length > 0, "artifact contents are empty");
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = await readFile(path.join(root, file));
    hash.update(Buffer.from(`${file.length}:`));
    hash.update(file);
    hash.update(Buffer.from(`${bytes.length}:`));
    hash.update(bytes);
  }
  return { sha256: hash.digest("hex"), files };
}

export async function digestBundledArtifact({ archivePath, contentsDirectory }) {
  const archiveFile = path.resolve(archivePath);
  const archiveStat = await lstat(archiveFile);
  assert.ok(archiveStat.isFile() && !archiveStat.isSymbolicLink(), "artifact archive must be a regular file");
  const archive = await readFile(archiveFile);
  assert.ok(archive.length > 0, "artifact archive is empty");
  const contents = await digestArtifactContents(contentsDirectory);
  return {
    archiveBytes: archive.length,
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    contentSha256: contents.sha256,
    files: contents.files
  };
}

export async function verifyDownloadedArtifact({ archivePath, contentsDirectory, metadata, candidateSha, expectedRunId, expectedRunAttempt, expectedName }) {
  assert.match(candidateSha ?? "", GIT_SHA, "candidate SHA is invalid");
  assert.ok(Number.isSafeInteger(expectedRunId) && expectedRunId > 0, "expected run ID is invalid");
  assert.ok(Number.isSafeInteger(expectedRunAttempt) && expectedRunAttempt > 0, "expected run attempt is invalid");
  assert.equal(metadata.id > 0, true, "artifact ID is invalid");
  assert.equal(metadata.name, expectedName, "artifact name differs");
  assert.equal(metadata.expired, false, "artifact is expired");
  assert.equal(metadata.workflow_run?.id, expectedRunId, "artifact run ID differs");
  assert.equal(metadata.workflow_run?.head_sha, candidateSha, "artifact candidate SHA differs");
  const digests = await digestBundledArtifact({ archivePath, contentsDirectory });
  return {
    verificationVersion: 1,
    artifactId: metadata.id,
    name: metadata.name,
    runId: expectedRunId,
    runAttempt: expectedRunAttempt,
    candidateSha,
    ...digests
  };
}

function arg(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) throw new Error(`Use ${name} <value>`);
  return argv[index + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  const result = await verifyDownloadedArtifact({
    archivePath: arg(argv, "--archive"),
    contentsDirectory: arg(argv, "--contents"),
    metadata: JSON.parse(await readFile(arg(argv, "--metadata"), "utf8")),
    candidateSha: arg(argv, "--candidate-sha"),
    expectedRunId: Number(arg(argv, "--run-id")),
    expectedRunAttempt: Number(arg(argv, "--run-attempt")),
    expectedName: arg(argv, "--name")
  });
  await writeFile(arg(argv, "--output"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ event: "staging.artifact.verified", artifactId: result.artifactId, archiveSha256: result.archiveSha256, contentSha256: result.contentSha256 }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "staging.artifact.invalid", reason: error.message }));
    process.exitCode = 1;
  });
}
