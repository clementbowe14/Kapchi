import { describe, expect, it, vi } from "vitest";
import {
  fetchListingGet,
  ListingContractError,
  parseGraduationStoleCollection,
  parseGraduationStoleDetail,
} from "./listings";

const availability = { availableQuantity: 3, label: "In stock", status: "available" };

const summary = {
  availability,
  basePriceCents: 15000,
  currency: "usd",
  fromPriceCents: 18000,
  id: "listing-1",
  isCustomizable: true,
  listingType: "graduation_stole",
  primaryImage: null,
  slug: "heritage-stole",
  subtitle: null,
  title: "Heritage Stole",
};

describe("graduation stole parsers", () => {
  it("accepts optional media and normalizes supported media forms", () => {
    expect(parseGraduationStoleCollection({ items: [summary] })).toMatchObject({
      items: [{ currency: "USD", primaryImage: null }],
      requestId: null,
    });

    const detail = parseGraduationStoleDetail({
      ...summary,
      customizationPackages: [
        {
          capabilities: { image: false, text: true, trim: false },
          fonts: [{ id: "font-1", name: "Serif" }],
          id: "package-1",
          kind: "text_short",
          limits: { maxChars: 24 },
          name: "Text",
          priceDeltaCents: 3000,
          priceVariants: [
            {
              currency: "usd",
              fontOptionId: null,
              id: "price-1",
              trimOptionId: null,
              unitAmountCents: 18000,
            },
          ],
          requirements: { image: false, text: true, trim: false },
          trims: [],
        },
      ],
      description: null,
      fabrics: [
        {
          availability,
          colorHex: "#112233",
          id: "fabric-1",
          image: "https://example.com/fabric.jpg",
          materialDescription: null,
          name: "Navy",
        },
      ],
      gallery: [{ altText: "Front", imageUrl: "https://example.com/front.jpg" }, null],
      policyNotice: "Policy",
    });

    expect(detail.gallery).toEqual([
      { alt: "Front", url: "https://example.com/front.jpg" },
    ]);
    expect(detail.fabrics[0].image?.url).toContain("fabric.jpg");
  });

  it("fails safely when required data is malformed", () => {
    expect(() =>
      parseGraduationStoleCollection({ items: [{ ...summary, title: "" }] }),
    ).toThrow(ListingContractError);
    expect(() =>
      parseGraduationStoleCollection({ items: [{ ...summary, isCustomizable: "yes" }] }),
    ).toThrow("isCustomizable");
  });
});

describe("listing GET retry policy", () => {
  it("retries retryable responses, honors Retry-After, and caps attempts", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { headers: { "retry-after": "1" }, status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const delay = vi.fn(async () => undefined);

    const response = await fetchListingGet("https://example.com/listings", {
      delay,
      fetcher,
      maxDelayMs: 500,
      random: () => 0.5,
    });

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenNthCalledWith(1, 500, undefined);
    expect(delay).toHaveBeenNthCalledWith(2, 300, undefined);
  });

  it("retries network errors but never retries non-retryable 4xx responses", async () => {
    const networkFetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await fetchListingGet("https://example.com/listings", {
      delay: async () => undefined,
      fetcher: networkFetcher,
    });
    expect(networkFetcher).toHaveBeenCalledTimes(2);

    const deniedFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    expect((await fetchListingGet("https://example.com/listings", { fetcher: deniedFetcher })).status).toBe(403);
    expect(deniedFetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry or delay after an abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = new DOMException("Aborted", "AbortError");
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(abort);
    const delay = vi.fn(async () => undefined);

    await expect(
      fetchListingGet("https://example.com/listings", {
        delay,
        fetcher,
        signal: controller.signal,
      }),
    ).rejects.toBe(abort);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it("rejects retry configurations beyond the request budget", async () => {
    await expect(
      fetchListingGet("https://example.com/listings", { maxAttempts: 4 }),
    ).rejects.toThrow("maxAttempts must be between 1 and 3");
  });
});
