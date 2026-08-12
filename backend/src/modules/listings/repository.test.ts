import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ListingsRepository } from "./repository.js";

const listing = {
  available_quantity: 0,
  base_price_cents: 8000,
  currency: "usd",
  description: "A woven stole",
  from_price_cents: 8500,
  id: "listing-1",
  is_customizable: true,
  listing_type: "graduation_stole",
  primary_image_alt: "Front of stole",
  primary_image_url: "https://cdn.test/stole.webp",
  requires_fabric: true,
  slug: "woven-stole",
  subtitle: "Made to order",
  title: "Woven Graduation Stole"
} as const;

describe("ListingsRepository public catalog contract", () => {
  it("filters list reads to active graduation stoles and ready public assets", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [listing] });
    const repository = new ListingsRepository({ query } as unknown as Pool);

    const result = await repository.listGraduationStoles();

    expect(result[0]).toMatchObject({
      availability: { availableQuantity: 0, status: "unavailable" },
      fromPriceCents: 8500,
      primaryImage: { url: "https://cdn.test/stole.webp" }
    });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("l.status = 'active'");
    expect(sql).toContain("l.archived_at is null");
    expect(sql).toContain("l.listing_type = 'graduation_stole'");
    expect(sql).toContain("cs.kind <> 'blank'");
    expect(sql).toContain("a.visibility = 'public_catalog'");
    expect(sql).toContain("a.status in ('uploaded', 'attached')");
    expect(sql).toContain("lpv.replaced_at is null");
    expect(sql).toContain("and exists (");
  });

  it("returns ordered public media, unavailable fabrics, capabilities and active prices", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("and l.slug = $1")) return { rows: [listing] };
      if (sql.includes("from assets a") && sql.includes("a.listing_id = $1")) {
        return { rows: [{ alt: "First", url: "https://cdn.test/1.webp" }] };
      }
      if (sql.includes("from listing_fabrics")) {
        return { rows: [{ available_quantity: 0, color_hex: "#001122", id: "fabric-1",
          image_alt: "Navy fabric", image_url: "https://cdn.test/navy.webp",
          material: "Satin", name: "Navy" }] };
      }
      if (sql.includes("from listing_customization_sets")) {
        return { rows: [{ default_max_chars: 120, id: "package-1", image_max_bytes: 5000000,
          kind: "text_image_trim", label: "Text, image, and trim", max_chars: null,
          min_chars: 1, price_delta_cents: 2500, requires_image: true,
          requires_text: true, requires_trim: true }] };
      }
      if (sql.includes("from listing_customization_fonts")) {
        return { rows: [{ id: "font-1", listing_customization_set_id: "package-1", name: "Serif" }] };
      }
      if (sql.includes("from listing_customization_trims")) {
        return { rows: [{ color_hex: "#D4AF37", id: "trim-1",
          listing_customization_set_id: "package-1", name: "Gold", price_delta_cents: 500 }] };
      }
      if (sql.includes("from listing_price_variants")) {
        return { rows: [{ currency: "usd", id: "variant-1",
          listing_customization_set_id: "package-1", trim_option_id: "trim-1",
          unit_amount_cents: 10500, variant_key: "image-gold" }] };
      }
      return { rows: [] };
    });
    const repository = new ListingsRepository({ query } as unknown as Pool);

    const result = await repository.getGraduationStole("woven-stole");

    expect(result).toMatchObject({
      fabrics: [{ availability: { status: "unavailable" }, image: { url: "https://cdn.test/navy.webp" } }],
      customizationPackages: [{
        capabilities: { image: true, text: true, trim: true },
        limits: { imageMaxBytes: 5000000, maxChars: 120 },
        priceVariants: [{ id: "variant-1", unitAmountCents: 10500 }]
      }]
    });
    const sql = query.mock.calls.map(([text]) => String(text)).join("\n");
    expect(sql).toContain("order by lf.sort_order");
    expect(sql).toContain("a.visibility = 'public_catalog'");
    expect(sql).toContain("lpv.active = true");
    expect(result?.policyNotice).toContain("unpaid additions will be rejected");
  });

  it("omits customization choices that the package does not allow", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("and l.slug = $1")) return { rows: [listing] };
      if (sql.includes("from listing_customization_sets")) {
        return {
          rows: [
            {
              default_max_chars: null,
              id: "blank-package",
              image_max_bytes: null,
              kind: "blank",
              label: "Blank",
              max_chars: null,
              min_chars: 0,
              price_delta_cents: 0,
              requires_image: false,
              requires_text: false,
              requires_trim: false
            }
          ]
        };
      }
      if (sql.includes("from listing_customization_fonts")) {
        return {
          rows: [
            {
              id: "font-1",
              listing_customization_set_id: "blank-package",
              name: "Serif"
            }
          ]
        };
      }
      if (sql.includes("from listing_customization_trims")) {
        return {
          rows: [
            {
              color_hex: "#D4AF37",
              id: "trim-1",
              listing_customization_set_id: "blank-package",
              name: "Gold",
              price_delta_cents: 500
            }
          ]
        };
      }
      return { rows: [] };
    });
    const repository = new ListingsRepository({ query } as unknown as Pool);

    const result = await repository.getGraduationStole("woven-stole");

    expect(result?.customizationPackages[0]).toMatchObject({
      capabilities: { image: false, text: false, trim: false },
      fonts: [],
      limits: {
        imageAllowedMimeTypes: [],
        imageMaxBytes: null,
        maxChars: null,
        minChars: 0
      },
      trims: []
    });
  });
});
