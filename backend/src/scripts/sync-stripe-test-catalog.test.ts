import { describe, expect, it, vi } from "vitest";
import { seedListings } from "../database/seed.js";
import type { StripeCatalogDatabaseClient } from "../modules/payments/stripe-catalog-sync.js";
import { recordCatalogAttestations } from "./sync-stripe-test-catalog.js";

function providerId(prefix: string, value: string) {
  return `${prefix}_${value.replaceAll("-", "_")}`;
}

function catalogResult() {
  return {
    accountId: "acct_test_fixture",
    bindings: seedListings.map((listing) => ({
      prices: listing.priceVariants.map((variant) => ({
        id: providerId("price_test", `${listing.slug}_${variant.variantKey}`),
        lookupKey: `fixture_${variant.variantKey}`,
        variantKey: variant.variantKey
      })),
      productId: providerId("prod_test", listing.slug),
      slug: listing.slug
    }))
  };
}

describe("recordCatalogAttestations", () => {
  it("attests every persisted fixture variant through the transaction client", async () => {
    const result = catalogResult();
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("select variants.stripe_product_id")) {
        const listing = seedListings.find((candidate) => candidate.slug === values[0]);
        const variant = listing?.priceVariants.find(
          (candidate) => candidate.variantKey === values[1],
        );
        return {
          rows: variant && listing
            ? [{
                stripe_price_id: providerId(
                  "price_test",
                  `${listing.slug}_${variant.variantKey}`,
                ),
                stripe_product_id: providerId("prod_test", listing.slug),
                unit_amount_cents: variant.unitAmountCents
              }]
            : []
        };
      }
      return { rows: [] };
    });

    const client = { query, release: vi.fn() } as unknown as StripeCatalogDatabaseClient;
    await recordCatalogAttestations(client, result);

    const inserts = query.mock.calls.filter(([sql]) =>
      sql.includes("insert into kapchi_fixture.catalog_attestations"),
    );
    expect(inserts).toHaveLength(
      seedListings.flatMap((listing) => listing.priceVariants).length,
    );
    expect(inserts[0]?.[1]).toEqual(expect.arrayContaining([
      "acct_test_fixture",
      expect.stringMatching(/^prod_test_/),
      expect.stringMatching(/^price_test_/)
    ]));
  });

  it("rejects a provider binding that does not match the committed catalog row", async () => {
    const result = catalogResult();
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("select variants.stripe_product_id")
        ? [{
            stripe_price_id: "price_wrong",
            stripe_product_id: "prod_wrong",
            unit_amount_cents: 1
          }]
        : []
    }));

    await expect(
      recordCatalogAttestations(
        { query, release: vi.fn() } as unknown as StripeCatalogDatabaseClient,
        result,
      ),
    ).rejects.toThrow("FIXTURE_CATALOG_BINDING_DRIFT");
    expect(query.mock.calls.some(([sql]) =>
      sql.includes("insert into kapchi_fixture.catalog_attestations"),
    )).toBe(false);
  });
});
