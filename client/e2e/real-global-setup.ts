import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export default function realGlobalSetup() {
  const storageState = resolve(
    process.cwd(),
    process.env.E2E_ADMIN_STORAGE_STATE ?? ".auth/admin.json",
  );
  if (!existsSync(storageState)) {
    throw new Error(
      `Authenticated Clerk storage state is required at ${storageState}. `
      + "See client/e2e/README.md.",
    );
  }

  const backendDirectory = resolve(process.cwd(), "../backend");
  execFileSync("npm", ["run", "db:assert-local"], {
    cwd: backendDirectory,
    stdio: "inherit",
  });
  execFileSync("npm", ["run", "db:migrate:apply"], {
    cwd: backendDirectory,
    stdio: "inherit",
  });
  execFileSync("npm", ["run", "db:seed:local"], {
    cwd: backendDirectory,
    stdio: "inherit",
  });
}
