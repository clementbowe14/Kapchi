import { describe, expect, it } from "vitest";
import { parseVercelCommandArguments } from "./vercel-command.js";

const common = [
  "--attempt-id", "stg_release_12345678",
  "--candidate-sha", "a".repeat(40),
  "--output-dir", "./artifacts",
];

describe("staging:vercel CLI", () => {
  it.each(["snapshot", "recover"])("parses the %s common contract", (mode) => {
    expect(parseVercelCommandArguments([mode, ...common])).toMatchObject({
      attemptId: "stg_release_12345678",
      candidateSha: "a".repeat(40),
      mode,
    });
  });

  it("requires prepare snapshot and verify manifest inputs", () => {
    expect(parseVercelCommandArguments(["prepare", ...common, "--snapshot", "snapshot.json"]).snapshot)
      .toMatch(/snapshot\.json$/);
    expect(parseVercelCommandArguments(["verify", ...common, "--manifest", "manifest.json"]).manifest)
      .toMatch(/manifest\.json$/);
    expect(() => parseVercelCommandArguments(["prepare", ...common])).toThrow("--snapshot is required");
    expect(() => parseVercelCommandArguments(["verify", ...common])).toThrow("--manifest is required");
  });

  it("rejects unknown modes and arguments", () => {
    expect(() => parseVercelCommandArguments(["deploy", ...common])).toThrow("Mode must be");
    expect(() => parseVercelCommandArguments(["snapshot", ...common, "--token", "secret"]))
      .toThrow("Unknown argument");
  });
});
