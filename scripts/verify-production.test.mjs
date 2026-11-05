import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyProduction } from "./verify-production.mjs";

const releaseSha = "a".repeat(40);
const releaseImageDigest = `sha256:${"b".repeat(64)}`;

function response(body, { status = 200, headers = {} } = {}) {
  const payload = status === 204 ? null : (typeof body === "string" ? body : JSON.stringify(body));
  return new Response(payload, { status, headers });
}

function successfulFetch() {
  return async (url, options = {}) => {
    const origin = options.headers?.origin;
    if (url.endsWith("/health")) {
      return response({ status: "ok", releaseSha, releaseImageDigest });
    }
    if (url.endsWith("/ready")) {
      return response({
        status: "ready",
        releaseSha,
        releaseImageDigest,
        dependencies: {
          database: "ready",
          redis: "ready",
          migrations: "ready",
          privateAssetProvider: "ready"
        },
        failedDependencyCodes: []
      });
    }
    if (url.endsWith("/cart")) {
      return response("", {
        status: 204,
        headers: origin === "https://shop.example.test" ? {
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true"
        } : {}
      });
    }
    if (url.endsWith("/admin/orders")) return response({}, { status: 401 });
    return response("storefront");
  };
}

test("verifies release identity, readiness, CORS, protected route, and storefront", async () => {
  const result = await verifyProduction({
    apiUrl: "https://api.example.test",
    clientUrl: "https://shop.example.test",
    releaseSha,
    releaseImageDigest,
    fetchImpl: successfulFetch()
  });
  assert.deepEqual(result.checks, ["health", "readiness", "cors-allow", "cors-deny", "protected-route", "storefront"]);
});

test("rejects an unready dependency without leaking its body", async () => {
  const fetchImpl = successfulFetch();
  await assert.rejects(
    verifyProduction({
      apiUrl: "https://api.example.test",
      clientUrl: "https://shop.example.test",
      releaseSha,
      releaseImageDigest,
      fetchImpl: async (url, options) => url.endsWith("/ready")
        ? response({ status: "unready", internal: "sensitive" }, { status: 503 })
        : fetchImpl(url, options)
    }),
    (error) => error.message.includes("readiness must return 200") && !error.message.includes("sensitive"),
  );
});

test("rejects non-HTTPS production origins", async () => {
  await assert.rejects(
    verifyProduction({
      apiUrl: "http://api.example.test",
      clientUrl: "https://shop.example.test",
      releaseSha,
      releaseImageDigest,
      fetchImpl: successfulFetch()
    }),
    /must use HTTPS/,
  );
});

test("bounds a hung external check", async () => {
  await assert.rejects(
    verifyProduction({
      apiUrl: "https://api.example.test",
      clientUrl: "https://shop.example.test",
      releaseSha,
      releaseImageDigest,
      timeoutMs: 100,
      fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    }),
    /aborted/,
  );
});

test("rejects a streamed response larger than the evidence bound", async () => {
  const fetchImpl = successfulFetch();
  await assert.rejects(
    verifyProduction({
      apiUrl: "https://api.example.test",
      clientUrl: "https://shop.example.test",
      releaseSha,
      releaseImageDigest,
      fetchImpl: async (url, options) => url.endsWith("/health")
        ? response("x".repeat(64 * 1024 + 1))
        : fetchImpl(url, options)
    }),
    /response is too large/,
  );
});
