import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadBackendEnvironment,
  resolveBackendEnvPath
} from "./load-environment.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function createTemporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kapchi-env-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("backend environment loading", () => {
  it.each(["src", "dist"])(
    "resolves backend/.env from the %s config module instead of the launch directory",
    (outputDirectory) => {
      const backendDirectory = path.join(
        path.parse(process.cwd()).root,
        "app",
        "backend",
      );
      const moduleUrl = pathToFileURL(
        path.join(
          backendDirectory,
          outputDirectory,
          "config",
          "load-environment.js",
        ),
      ).href;

      expect(resolveBackendEnvPath(moduleUrl)).toBe(
        path.join(backendDirectory, ".env"),
      );
    },
  );

  it("loads the explicit backend env file without overriding runtime variables", async () => {
    const directory = await createTemporaryDirectory();
    const envFilePath = path.join(directory, ".env");
    const environment = {
      STRIPE_SECRET_KEY: "sk_test_runtime_fixture"
    };
    await writeFile(
      envFilePath,
      [
        "STRIPE_SECRET_KEY=sk_test_file_fixture",
        "STRIPE_WEBHOOK_SECRET=whsec_file_fixture"
      ].join("\n"),
    );

    const source = loadBackendEnvironment({ envFilePath, environment });

    expect(source).toEqual({ envFileLoaded: true, envFilePath });
    expect(environment).toEqual({
      STRIPE_SECRET_KEY: "sk_test_runtime_fixture",
      STRIPE_WEBHOOK_SECRET: "whsec_file_fixture"
    });
  });

  it("allows deployment-provided variables when the optional env file is absent", async () => {
    const directory = await createTemporaryDirectory();
    const envFilePath = path.join(directory, ".env");
    const environment = { STRIPE_SECRET_KEY: "sk_test_deployment_fixture" };

    expect(loadBackendEnvironment({ envFilePath, environment })).toEqual({
      envFileLoaded: false,
      envFilePath
    });
    expect(environment.STRIPE_SECRET_KEY).toBe("sk_test_deployment_fixture");
  });

  it("does not treat a malformed Stripe variable name as STRIPE_SECRET_KEY", async () => {
    const directory = await createTemporaryDirectory();
    const envFilePath = path.join(directory, ".env");
    const environment: Record<string, string> = {};
    await writeFile(
      envFilePath,
      [
        "STRIPE_SECRET_ KEY=sk_test_malformed_fixture",
        "STRIPE_WEBHOOK_SECRET=whsec_fixture"
      ].join("\n"),
    );

    loadBackendEnvironment({ envFilePath, environment });

    expect(environment).not.toHaveProperty("STRIPE_SECRET_KEY");
    expect(environment.STRIPE_WEBHOOK_SECRET).toBe("whsec_fixture");
  });
});
