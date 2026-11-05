#!/usr/bin/env node

import assert from "node:assert/strict";
import process from "node:process";
import { pathToFileURL } from "node:url";

const maxResponseBytes = 64 * 1024;
const defaultTimeoutMs = 5000;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-http") {
      options.allowHttp = true;
      continue;
    }
    if (!argument.startsWith("--") || !argv[index + 1]) {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
    options[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

function exactOrigin(raw, label, allowHttp = false) {
  const url = new URL(raw);
  assert.ok(allowHttp || url.protocol === "https:", `${label} must use HTTPS`);
  assert.ok(["https:", "http:"].includes(url.protocol), `${label} has an unsupported protocol`);
  assert.equal(url.username, "", `${label} must not include credentials`);
  assert.equal(url.password, "", `${label} must not include credentials`);
  assert.equal(url.search, "", `${label} must not include a query`);
  assert.equal(url.hash, "", `${label} must not include a fragment`);
  assert.ok(url.pathname === "/" || url.pathname === "", `${label} must be an origin without a path`);
  return url.origin;
}

async function readBoundedJson(response, label) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  assert.ok(!declaredLength || declaredLength <= maxResponseBytes, `${label} response is too large`);
  const reader = response.body?.getReader();
  assert.ok(reader, `${label} response has no body`);
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxResponseBytes) {
      await reader.cancel();
      throw new Error(`${label} response is too large`);
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
}

async function boundedFetch(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      redirect: "error",
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyProduction({
  apiUrl,
  clientUrl,
  releaseSha,
  releaseDeploymentId,
  timeoutMs = defaultTimeoutMs,
  allowHttp = false,
  fetchImpl = fetch
}) {
  assert.match(releaseSha, /^[0-9a-f]{40}$/i, "release SHA must be a full Git SHA");
  assert.match(releaseDeploymentId, /^dpl_[A-Za-z0-9]+$/, "release deployment ID must be a Vercel deployment ID");
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 15000, "timeout must be 100-15000ms");

  const apiOrigin = exactOrigin(apiUrl, "API URL", allowHttp);
  const clientOrigin = exactOrigin(clientUrl, "client URL", allowHttp);
  assert.notEqual(apiOrigin, clientOrigin, "API and client origins must be distinct");
  const checks = [];

  const healthResponse = await boundedFetch(fetchImpl, `${apiOrigin}/health`, { method: "GET" }, timeoutMs);
  assert.equal(healthResponse.status, 200, "health must return 200");
  const health = await readBoundedJson(healthResponse, "health");
  assert.equal(health.releaseSha, releaseSha, "health release SHA does not match");
  assert.equal(health.releaseDeploymentId, releaseDeploymentId, "health deployment ID does not match");
  checks.push("health");

  const readyResponse = await boundedFetch(fetchImpl, `${apiOrigin}/ready`, { method: "GET" }, timeoutMs);
  assert.equal(readyResponse.status, 200, "readiness must return 200");
  const readiness = await readBoundedJson(readyResponse, "readiness");
  assert.equal(readiness.status, "ready", "readiness status must be ready");
  assert.equal(readiness.releaseSha, releaseSha, "readiness release SHA does not match");
  assert.equal(readiness.releaseDeploymentId, releaseDeploymentId, "readiness deployment ID does not match");
  assert.deepEqual(readiness.failedDependencyCodes, [], "readiness reports failed dependencies");
  for (const dependency of ["database", "redis", "migrations", "privateAssetProvider"]) {
    assert.equal(readiness.dependencies?.[dependency], "ready", `${dependency} is not ready`);
  }
  checks.push("readiness");

  const allowedCors = await boundedFetch(fetchImpl, `${apiOrigin}/cart`, {
    method: "OPTIONS",
    headers: {
      origin: clientOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type"
    }
  }, timeoutMs);
  assert.ok([200, 204].includes(allowedCors.status), "allowed CORS preflight must succeed");
  assert.equal(allowedCors.headers.get("access-control-allow-origin"), clientOrigin, "CORS must echo only the client origin");
  assert.equal(allowedCors.headers.get("access-control-allow-credentials"), "true", "credentialed CORS must be enabled");
  checks.push("cors-allow");

  const deniedOrigin = "https://origin-denied.invalid";
  const deniedCors = await boundedFetch(fetchImpl, `${apiOrigin}/cart`, {
    method: "OPTIONS",
    headers: {
      origin: deniedOrigin,
      "access-control-request-method": "POST"
    }
  }, timeoutMs);
  assert.notEqual(deniedCors.headers.get("access-control-allow-origin"), deniedOrigin, "unauthorized CORS origin was granted");
  checks.push("cors-deny");

  const protectedResponse = await boundedFetch(fetchImpl, `${apiOrigin}/admin/orders`, {
    method: "GET",
    headers: { origin: clientOrigin }
  }, timeoutMs);
  assert.ok([401, 403].includes(protectedResponse.status), "admin route must deny an unauthenticated request");
  checks.push("protected-route");

  const storefrontResponse = await boundedFetch(fetchImpl, clientOrigin, { method: "GET" }, timeoutMs);
  assert.equal(storefrontResponse.status, 200, "storefront must return 200");
  checks.push("storefront");

  return {
    event: "production.verification.completed",
    releaseSha,
    releaseDeploymentId,
    checkedAt: new Date().toISOString(),
    checks
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await verifyProduction({
    apiUrl: args["api-url"],
    clientUrl: args["client-url"],
    releaseSha: args["release-sha"],
    releaseDeploymentId: args["deployment-id"],
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : defaultTimeoutMs,
    allowHttp: args.allowHttp
  });
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: "production.verification.failed",
      errorCode: "PRODUCTION_VERIFICATION_FAILED",
      reason: error instanceof Error ? error.message : "verification failed"
    }));
    process.exitCode = 1;
  });
}
