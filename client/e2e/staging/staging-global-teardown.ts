import { readStagingPlaywrightSettings } from "../../lib/staging-playwright";
import { teardownStagingIdentities } from "./identity-runtime";

export default async function stagingGlobalTeardown() {
  await teardownStagingIdentities(readStagingPlaywrightSettings());
}
