import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrivateAssetProviderError } from "./errors.js";
import type { AdminAssetRepositoryPort } from "./repository.js";
import { AdminAssetService } from "./service.js";
import type { PrivateAssetLookup, PrivateAssetReader } from "./types.js";

const orderId = "11111111-1111-4111-8111-111111111111";
const orderItemId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const storageKey = `kapchi/customization_image/${assetId}/crest.png`;
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nzsAAAAASUVORK5CYII=",
    "base64",
  ),
);

function lookup(overrides: Partial<PrivateAssetLookup> = {}): PrivateAssetLookup {
  return {
    asset: {
      byteSize: png.byteLength,
      checksum: "etag-1",
      contentType: "image/png",
      context: "customization_image",
      expectedPathname: storageKey,
      id: assetId,
      originalFilename: "Crest.png",
      provider: "vercel_blob",
      status: "attached",
      storageKey,
      visibility: "private"
    },
    canonicalAssetId: assetId,
    orderId,
    orderItemId,
    paidAt: "2026-10-26T12:00:00.000Z",
    snapshotAssetId: assetId,
    ...overrides
  };
}

function stream(bytes = png) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

describe("admin private asset service", () => {
  let current: PrivateAssetLookup;
  let repository: AdminAssetRepositoryPort;
  let reader: PrivateAssetReader;
  let service: AdminAssetService;

  beforeEach(() => {
    current = lookup();
    repository = {
      findActor: vi.fn(async () => ({ authSubject: "user_admin", userId: orderId })),
      lookup: vi.fn(async () => current),
      recordAccess: vi.fn(async () => assetId),
      updateDelivery: vi.fn(async () => undefined)
    };
    reader = {
      configured: true,
      open: vi.fn(async () => ({
        checksum: "etag-1",
        contentType: "image/png",
        pathname: storageKey,
        size: png.byteLength,
        stream: stream()
      }))
    };
    service = new AdminAssetService(repository, {
      idleTimeoutMs: 1000,
      maxBytes: 1024,
      openTimeoutMs: 1000,
      readers: { vercel_blob: reader }
    });
  });

  it("returns DB-only eligible metadata without opening the provider", async () => {
    await expect(service.metadata(orderId, orderItemId)).resolves.toMatchObject({
      asset: {
        byteSize: png.byteLength,
        contentType: "image/png",
        filename: "Crest.png",
        id: assetId,
        recordStatus: "attached",
        visibility: "private"
      },
      retrieval: {
        eligibility: "eligible",
        reasonCode: null
      }
    });
    expect(reader.open).not.toHaveBeenCalled();
  });

  it.each([
    {
      eligibility: "order_not_purchased",
      overrides: { paidAt: null },
      reasonCode: "ORDER_NOT_PURCHASED"
    },
    {
      eligibility: "reference_mismatch",
      overrides: { snapshotAssetId: "44444444-4444-4444-8444-444444444444" },
      reasonCode: "ASSET_REFERENCE_MISMATCH"
    },
    {
      eligibility: "record_missing",
      overrides: { asset: null, canonicalAssetId: null },
      reasonCode: "ASSET_RECORD_MISSING"
    },
    {
      eligibility: "quarantined",
      overrides: { asset: { ...lookup().asset!, status: "quarantined" } },
      reasonCode: "ASSET_QUARANTINED"
    },
    {
      eligibility: "binding_invalid",
      overrides: { asset: { ...lookup().asset!, storageKey: "https://evil.test/object" } },
      reasonCode: "ASSET_BINDING_INVALID"
    }
  ])("reports $eligibility without content links", async ({ eligibility, overrides, reasonCode }) => {
    current = lookup(overrides as Partial<PrivateAssetLookup>);
    const result = await service.metadata(orderId, orderItemId);
    expect(result.retrieval).toEqual({
      downloadUrl: null,
      eligibility,
      previewUrl: null,
      reasonCode
    });
    expect(reader.open).not.toHaveBeenCalled();
  });

  it("opens, validates, rechecks, and streams the bound image", async () => {
    const prepared = await service.prepare(orderId, orderItemId, new AbortController().signal);
    const body = new Uint8Array(await new Response(prepared.stream).arrayBuffer());

    expect(body).toEqual(png);
    expect(prepared.bytesRead()).toBe(png.byteLength);
    expect(repository.lookup).toHaveBeenCalledTimes(2);
    expect(reader.open).toHaveBeenCalledWith({
      abortSignal: expect.any(AbortSignal),
      storageKey
    });
  });

  it("retries one transient provider-open failure before client bytes", async () => {
    vi.mocked(reader.open)
      .mockRejectedValueOnce(new PrivateAssetProviderError("unavailable"))
      .mockResolvedValueOnce({
        checksum: "etag-1",
        contentType: "image/png",
        pathname: storageKey,
        size: png.byteLength,
        stream: stream()
      });

    const prepared = await service.prepare(orderId, orderItemId, new AbortController().signal);
    expect(prepared.retryCount).toBe(1);
    expect(reader.open).toHaveBeenCalledTimes(2);
  });

  it.each([
    { code: "ASSET_CONTENT_MISSING", kind: "not_found", statusCode: 410 },
    { code: "ASSET_PROVIDER_MISCONFIGURED", kind: "misconfigured", statusCode: 503 }
  ] as const)("maps $kind provider failures to $code", async ({ code, kind, statusCode }) => {
    vi.mocked(reader.open).mockRejectedValue(new PrivateAssetProviderError(kind));

    await expect(
      service.prepare(orderId, orderItemId, new AbortController().signal),
    ).rejects.toMatchObject({ code, statusCode });
  });

  it("retries a rate limit once and then returns a retryable safe error", async () => {
    vi.mocked(reader.open).mockRejectedValue(
      new PrivateAssetProviderError("rate_limited", { retryAfterSeconds: 12 }),
    );

    await expect(
      service.prepare(orderId, orderItemId, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "ASSET_PROVIDER_UNAVAILABLE",
      retryAfterSeconds: 12,
      retryable: true,
      statusCode: 503
    });
    expect(reader.open).toHaveBeenCalledTimes(2);
  });

  it("fails closed when provider metadata does not match the database", async () => {
    vi.mocked(reader.open).mockResolvedValueOnce({
      checksum: "different-etag",
      contentType: "image/png",
      pathname: storageKey,
      size: png.byteLength,
      stream: stream()
    });

    await expect(
      service.prepare(orderId, orderItemId, new AbortController().signal),
    ).rejects.toMatchObject({ code: "ASSET_CONTENT_INVALID", statusCode: 502 });
  });

  it("rejects active content even when provider metadata claims an image", async () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    current = lookup({
      asset: { ...lookup().asset!, byteSize: html.byteLength, checksum: null }
    });
    vi.mocked(reader.open).mockResolvedValueOnce({
      checksum: null,
      contentType: "image/png",
      pathname: storageKey,
      size: html.byteLength,
      stream: stream(html)
    });

    await expect(
      service.prepare(orderId, orderItemId, new AbortController().signal),
    ).rejects.toMatchObject({ code: "ASSET_CONTENT_INVALID", statusCode: 502 });
  });
});
