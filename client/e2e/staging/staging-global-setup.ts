import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { assertPublicApiResponse, readStagingPlaywrightSettings } from "../../lib/staging-playwright";
import { setupStagingIdentities } from "./identity-runtime";

export default async function stagingGlobalSetup() {
  const settings = readStagingPlaywrightSettings();
  await rm(settings.resultsPath, { force: true });
  await mkdir(dirname(settings.resultsPath), { recursive: true });
  const readiness = await fetch(`${settings.apiOrigin}/ready`);
  assertPublicApiResponse(readiness);
  if (!readiness.ok) throw new Error(`Staging API readiness failed with HTTP ${readiness.status}.`);
  await setupStagingIdentities(settings);
}
