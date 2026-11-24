import { describe, expect, it, vi } from "vitest";
import { VercelClient, VercelOperationError } from "./vercel-client.js";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "cache-control": "no-store", "content-type": "application/json", ...init.headers },
  });
}

const deployment = {
  createdAt: 100,
  meta: { githubCommitRef: "staging", githubCommitSha: "a".repeat(40) },
  projectId: "prj_api",
  readyState: "READY",
  target: "preview",
  uid: "dpl_api",
  url: "api-build.vercel.app",
};

describe("VercelClient", () => {
  it("retries rate-limited reads using Retry-After and validates deployments", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({}, { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(json({ deployments: [deployment] }));
    const sleep = vi.fn(async () => undefined);
    const client = new VercelClient("token-value", "team-id", {
      fetch: fetchMock,
      now: () => 1_000,
      random: () => 0,
      sleep,
    });

    await expect(client.listDeployments("prj_api")).resolves.toEqual([{
      createdAt: 100,
      id: "dpl_api",
      projectId: "prj_api",
      readyAt: undefined,
      readyState: "READY",
      ref: "staging",
      sha: "a".repeat(40),
      target: "preview",
      url: "api-build.vercel.app",
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0);
    expect(String(fetchMock.mock.calls[0]![1]?.headers?.authorization)).toBe("Bearer token-value");
  });

  it("does not retry authentication failures or expose response bodies", async () => {
    const fetchMock = vi.fn(async () => json({ token: "provider-secret" }, { status: 401 }));
    const client = new VercelClient("token-value", "team-id", { fetch: fetchMock });
    await expect(client.getDeployment("dpl_missing")).rejects.toMatchObject({
      code: "HTTP_401",
      operation: "deployment.get",
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(client.getDeployment("dpl_missing")).rejects.not.toThrow("provider-secret");
  });

  it("hardens probes against redirects, caching, and bypass leakage", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({}, { status: 302, headers: { location: "https://evil.example" } }))
      .mockResolvedValueOnce(json({ ok: true }, { headers: { "cache-control": "public", "content-type": "application/json" } }))
      .mockResolvedValueOnce(json({ ok: true }));
    const client = new VercelClient("token-value", "team-id", { fetch: fetchMock });
    await expect(client.probeJson("https://store.vercel.app", "/api/release", { bypassSecret: "bypass" }))
      .rejects.toMatchObject({ code: "PROBE_REDIRECT" });
    await expect(client.probeJson("https://api.vercel.app", "/health"))
      .rejects.toMatchObject({ code: "PROBE_CACHEABLE" });
    await expect(client.probeJson("https://api.vercel.app", "/health")).resolves.toMatchObject({ status: 200 });
    expect(fetchMock.mock.calls[0]![1]?.redirect).toBe("manual");
    expect(fetchMock.mock.calls[0]![1]?.headers).toEqual({ "x-vercel-protection-bypass": "bypass" });
    expect(fetchMock.mock.calls[2]![1]?.headers).toBeUndefined();
  });

  it("rejects malformed successful provider payloads", async () => {
    const client = new VercelClient("token-value", "team-id", {
      fetch: vi.fn(async () => json({ uid: "dpl_missing_fields" })),
    });
    await expect(client.getDeployment("dpl_missing_fields")).rejects.toBeInstanceOf(VercelOperationError);
  });

  it("reconciles an ambiguous final alias mutation before failing", async () => {
    const alias = (deploymentId: string) => ({ alias: "api.staging.kapchi.test", deploymentId, projectId: "prj_api" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(alias("dpl_old")))
      .mockResolvedValueOnce(json({}, { status: 500 }))
      .mockResolvedValueOnce(json(alias("dpl_old")))
      .mockResolvedValueOnce(json({}, { status: 500 }))
      .mockResolvedValueOnce(json(alias("dpl_old")))
      .mockResolvedValueOnce(json({}, { status: 500 }))
      .mockResolvedValueOnce(json(alias("dpl_new")));
    const sleep = vi.fn(async () => undefined);
    const client = new VercelClient("token-value", "team-id", {
      fetch: fetchMock,
      now: () => 1_000,
      random: () => 0,
      sleep,
    });

    await expect(client.assignAlias("dpl_new", "api.staging.kapchi.test")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("retries transient release probes without forwarding a bypass header", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ unavailable: true }, { status: 503, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(json({ status: "ok" }));
    const sleep = vi.fn(async () => undefined);
    const client = new VercelClient("token-value", "team-id", {
      fetch: fetchMock,
      now: () => 1_000,
      random: () => 0,
      sleep,
    });

    await expect(client.probeJson("https://api.vercel.app", "/health")).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every((call) => call[1]?.headers === undefined)).toBe(true);
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it("cancels in-flight work while keeping the client available for recovery", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }))
      .mockResolvedValueOnce(json(deployment));
    const client = new VercelClient("token-value", "team-id", { fetch: fetchMock });

    const pending = client.getDeployment("dpl_pending");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    client.abortPending();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(client.getDeployment("dpl_recovery")).resolves.toMatchObject({ id: "dpl_api" });
  });
});

