import { unbindFixtureAdmin } from "./bind-fixture-admin.js";
import { safeFixtureFailure } from "../database/fixtures/safety.js";

unbindFixtureAdmin().catch((error: unknown) => {
  console.error(JSON.stringify(safeFixtureFailure(error)));
  process.exitCode = 1;
});
