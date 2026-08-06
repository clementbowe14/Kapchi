import { config as loadDotEnv } from "dotenv";
import type { DotenvPopulateInput } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type BackendEnvironmentSource = Readonly<{
  envFileLoaded: boolean;
  envFilePath: string;
}>;

type LoadBackendEnvironmentOptions = {
  envFilePath?: string;
  environment?: DotenvPopulateInput;
};

export function resolveBackendEnvPath(moduleUrl = import.meta.url) {
  return path.resolve(
    path.dirname(fileURLToPath(moduleUrl)),
    "..",
    "..",
    ".env",
  );
}

export function loadBackendEnvironment({
  envFilePath = resolveBackendEnvPath(),
  environment = process.env as DotenvPopulateInput
}: LoadBackendEnvironmentOptions = {}): BackendEnvironmentSource {
  const result = loadDotEnv({
    override: false,
    path: envFilePath,
    processEnv: environment,
    quiet: true
  });
  const loadError = result.error as NodeJS.ErrnoException | undefined;

  if (loadError && loadError.code !== "ENOENT") {
    throw new Error(`Unable to read backend environment file: ${envFilePath}`);
  }

  return Object.freeze({
    envFileLoaded: !loadError,
    envFilePath
  });
}
