import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readJsonFile, writeAtomicJson } from "./vercel-evidence.js";

describe("Vercel staging evidence", () => {
  it("writes complete JSON atomically and reads it back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kapchi-vercel-evidence-"));
    const path = join(directory, "snapshot.json");
    const value = { attemptId: "stg_release_12345678", candidateSha: "a".repeat(40), schemaVersion: 1 };
    await expect(writeAtomicJson(path, value)).resolves.toEqual(value);
    await expect(readJsonFile(path)).resolves.toEqual(value);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  it.each(["token", "bypassSecret", "authorization", "password"])("rejects the forbidden %s field", async (key) => {
    const directory = await mkdtemp(join(tmpdir(), "kapchi-vercel-redaction-"));
    await expect(writeAtomicJson(join(directory, "report.json"), { [key]: "sensitive" }))
      .rejects.toThrow("forbidden field");
  });
});

