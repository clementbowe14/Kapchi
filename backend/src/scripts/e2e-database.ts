const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);

export function assertIsolatedE2eDatabaseUrl(
  value: string | undefined,
  comparedUrls: Array<string | undefined>,
) {
  if (!value) throw new Error("E2E_DATABASE_URL is required.");
  const url = new URL(value);
  const databaseName = url.pathname.replace(/^\//, "");
  if (!loopbackHosts.has(url.hostname) || !databaseName.endsWith("_e2e")) {
    throw new Error("E2E_DATABASE_URL must use a loopback host and a database ending in _e2e.");
  }
  if (comparedUrls.filter(Boolean).some((candidate) => candidate === value)) {
    throw new Error("E2E_DATABASE_URL must not match a normal, staging, or production database URL.");
  }
  return value;
}
