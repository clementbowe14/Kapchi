import type { Pool, QueryResultRow } from "pg";
import {
  UNPAID_CUSTOMIZATION_POLICY_NOTICE,
  type GraduationStoleDetail,
  type GraduationStoleSummary,
  type ListingAvailability,
  type ListingMedia
} from "./types.js";

type SummaryRow = QueryResultRow & {
  available_quantity: number | string | null;
  base_price_cents: number;
  currency: string;
  from_price_cents: number | string | null;
  id: string;
  is_customizable: boolean;
  listing_type: "graduation_stole";
  primary_image_alt: string | null;
  primary_image_url: string | null;
  requires_fabric: boolean;
  slug: string;
  subtitle: string | null;
  title: string;
};

type DetailRow = SummaryRow & { description: string | null };
type MediaRow = QueryResultRow & { alt: string | null; url: string };
type FabricRow = QueryResultRow & {
  available_quantity: number | string;
  color_hex: string | null;
  id: string;
  image_alt: string | null;
  image_url: string | null;
  material: string | null;
  name: string;
};
type PackageRow = QueryResultRow & {
  default_max_chars: number | null;
  id: string;
  image_max_bytes: number | null;
  kind: string;
  label: string;
  max_chars: number | null;
  min_chars: number;
  price_delta_cents: number;
  requires_image: boolean;
  requires_text: boolean;
  requires_trim: boolean;
};
type FontRow = QueryResultRow & {
  id: string;
  listing_customization_set_id: string;
  name: string;
};
type TrimRow = QueryResultRow & {
  color_hex: string | null;
  id: string;
  listing_customization_set_id: string;
  name: string;
  price_delta_cents: number;
};
type VariantRow = QueryResultRow & {
  currency: string;
  id: string;
  listing_customization_set_id: string;
  trim_option_id: string | null;
  unit_amount_cents: number;
  variant_key: string;
};

const PUBLIC_ASSET_FILTER = `
  a.visibility = 'public_catalog'
  and a.status in ('uploaded', 'attached')
  and a.url is not null`;

const SUMMARY_SELECT = `
  select
    l.id,
    l.slug,
    l.title,
    l.subtitle,
    l.description,
    l.listing_type,
    l.base_price_cents,
    l.currency,
    l.requires_fabric,
    coalesce(prices.from_price_cents, l.base_price_cents) as from_price_cents,
    exists (
      select 1
      from listing_customization_sets lcs
      join customization_sets cs on cs.id = lcs.customization_set_id
      where lcs.listing_id = l.id
        and lcs.enabled = true
        and cs.kind <> 'blank'
        and exists (
          select 1
          from listing_price_variants lpv
          where lpv.listing_id = l.id
            and lpv.listing_customization_set_id = lcs.id
            and lpv.active = true
            and lpv.replaced_at is null
        )
    ) as is_customizable,
    case
      when l.requires_fabric then coalesce(inventory.available_quantity, 0)
      else null
    end as available_quantity,
    primary_asset.url as primary_image_url,
    primary_asset.alt as primary_image_alt
  from listings l
  left join lateral (
    select min(lpv.unit_amount_cents) as from_price_cents
    from listing_price_variants lpv
    join listing_customization_sets lcs
      on lcs.id = lpv.listing_customization_set_id
     and lcs.listing_id = l.id
     and lcs.enabled = true
    where lpv.listing_id = l.id
      and lpv.active = true
      and lpv.replaced_at is null
  ) prices on true
  left join lateral (
    select sum(greatest(f.quantity_on_hand - f.quantity_reserved, 0))::integer
      as available_quantity
    from listing_fabrics lf
    join fabrics f on f.id = lf.fabric_id and f.status = 'active'
    where lf.listing_id = l.id and lf.active = true
  ) inventory on true
  left join lateral (
    select
      a.url,
      nullif(a.metadata ->> 'alt', '') as alt
    from assets a
    where a.listing_id = l.id
      and a.context = 'catalog_listing_image'
      and ${PUBLIC_ASSET_FILTER}
    order by
      case when lower(a.metadata ->> 'isPrimary') = 'true' then 1 else 0 end desc,
      case when (a.metadata ->> 'sortOrder') ~ '^[0-9]+$'
        then (a.metadata ->> 'sortOrder')::integer else 2147483647 end,
      a.created_at,
      a.id
    limit 1
  ) primary_asset on true
  where l.status = 'active'
    and l.archived_at is null
    and l.listing_type = 'graduation_stole'
    and exists (
      select 1
      from listing_price_variants lpv
      join listing_customization_sets lcs
        on lcs.id = lpv.listing_customization_set_id
       and lcs.listing_id = l.id
       and lcs.enabled = true
      where lpv.listing_id = l.id
        and lpv.active = true
        and lpv.replaced_at is null
    )`;

function numeric(value: number | string | null, fallback: number) {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function availability(requiresFabric: boolean, quantity: number | string | null): ListingAvailability {
  if (!requiresFabric) {
    return { availableQuantity: null, label: "Available", status: "available" };
  }
  const availableQuantity = numeric(quantity, 0);
  if (availableQuantity === 0) {
    return { availableQuantity, label: "Unavailable", status: "unavailable" };
  }
  if (availableQuantity <= 5) {
    return { availableQuantity, label: "Low stock", status: "low_stock" };
  }
  return { availableQuantity, label: "Available", status: "available" };
}

function media(url: string | null, alt: string | null): ListingMedia | null {
  return url ? { alt, url } : null;
}

function summary(row: SummaryRow): GraduationStoleSummary {
  return {
    availability: availability(row.requires_fabric, row.available_quantity),
    basePriceCents: row.base_price_cents,
    currency: row.currency,
    fromPriceCents: numeric(row.from_price_cents, row.base_price_cents),
    id: row.id,
    isCustomizable: row.is_customizable,
    listingType: row.listing_type,
    primaryImage: media(row.primary_image_url, row.primary_image_alt),
    slug: row.slug,
    subtitle: row.subtitle,
    title: row.title
  };
}

function capabilities(kind: string) {
  return {
    image: kind === "text_image" || kind === "text_image_trim",
    text: ["text_short", "text_long", "text_image", "text_image_trim"].includes(kind),
    trim: kind === "text_image_trim"
  };
}

export class ListingsRepository {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async listGraduationStoles() {
    const result = await this.pool.query<SummaryRow>(
      `${SUMMARY_SELECT} order by l.created_at desc, l.id`,
    );
    return result.rows.map(summary);
  }

  async getGraduationStole(slug: string): Promise<GraduationStoleDetail | null> {
    const listingResult = await this.pool.query<DetailRow>(
      `${SUMMARY_SELECT} and l.slug = $1 limit 1`,
      [slug],
    );
    const row = listingResult.rows[0];
    if (!row) return null;

    const [galleryResult, fabricResult, packageResult, fontResult, trimResult, variantResult] =
      await Promise.all([
        this.pool.query<MediaRow>(
          `select a.url, nullif(a.metadata ->> 'alt', '') as alt
           from assets a
           where a.listing_id = $1
             and a.context = 'catalog_listing_image'
             and ${PUBLIC_ASSET_FILTER}
           order by
             case when (a.metadata ->> 'sortOrder') ~ '^[0-9]+$'
               then (a.metadata ->> 'sortOrder')::integer else 2147483647 end,
             a.created_at, a.id`,
          [row.id],
        ),
        this.pool.query<FabricRow>(
          `select f.id, f.name, f.color_hex, f.material,
                  greatest(f.quantity_on_hand - f.quantity_reserved, 0) as available_quantity,
                  image.url as image_url, image.alt as image_alt
           from listing_fabrics lf
           join fabrics f on f.id = lf.fabric_id and f.status = 'active'
           left join lateral (
             select a.url, nullif(a.metadata ->> 'alt', '') as alt
             from assets a
             where a.fabric_id = f.id and a.context = 'fabric_image'
               and ${PUBLIC_ASSET_FILTER}
             order by case when (a.metadata ->> 'sortOrder') ~ '^[0-9]+$'
                       then (a.metadata ->> 'sortOrder')::integer else 2147483647 end,
                      a.created_at, a.id
             limit 1
           ) image on true
           where lf.listing_id = $1 and lf.active = true
           order by lf.sort_order, f.name, f.id`,
          [row.id],
        ),
        this.pool.query<PackageRow>(
          `select lcs.id, cs.kind, cs.label, cs.requires_text, cs.requires_image,
                  cs.requires_trim, cs.default_max_chars, lcs.price_delta_cents,
                  lcs.max_chars, lcs.min_chars, lcs.image_max_bytes
           from listing_customization_sets lcs
           join customization_sets cs on cs.id = lcs.customization_set_id
           where lcs.listing_id = $1
             and lcs.enabled = true
             and exists (
               select 1
               from listing_price_variants lpv
               where lpv.listing_id = lcs.listing_id
                 and lpv.listing_customization_set_id = lcs.id
                 and lpv.active = true
                 and lpv.replaced_at is null
             )
           order by lcs.sort_order, lcs.id`,
          [row.id],
        ),
        this.pool.query<FontRow>(
          `select lcf.listing_customization_set_id, f.id, f.name
           from listing_customization_fonts lcf
           join font_options f on f.id = lcf.font_option_id and f.active = true
           join listing_customization_sets lcs on lcs.id = lcf.listing_customization_set_id
           where lcs.listing_id = $1 and lcs.enabled = true
           order by f.name, f.id`,
          [row.id],
        ),
        this.pool.query<TrimRow>(
          `select lct.listing_customization_set_id, t.id, t.name, t.color_hex,
                  t.price_delta_cents
           from listing_customization_trims lct
           join trim_options t on t.id = lct.trim_option_id and t.active = true
           join listing_customization_sets lcs on lcs.id = lct.listing_customization_set_id
           where lcs.listing_id = $1 and lcs.enabled = true
           order by t.name, t.id`,
          [row.id],
        ),
        this.pool.query<VariantRow>(
          `select lpv.id, lpv.listing_customization_set_id, lpv.trim_option_id,
                  lpv.variant_key, lpv.unit_amount_cents, lpv.currency
           from listing_price_variants lpv
           join listing_customization_sets lcs
             on lcs.id = lpv.listing_customization_set_id
            and lcs.listing_id = lpv.listing_id
            and lcs.enabled = true
           where lpv.listing_id = $1 and lpv.active = true and lpv.replaced_at is null
           order by lpv.unit_amount_cents, lpv.variant_key, lpv.id`,
          [row.id],
        )
      ]);

    return {
      ...summary(row),
      customizationPackages: packageResult.rows.map((item) => {
        const packageCapabilities = capabilities(item.kind);

        return {
          capabilities: packageCapabilities,
          fonts: packageCapabilities.text
            ? fontResult.rows
                .filter((font) => font.listing_customization_set_id === item.id)
                .map((font) => ({ id: font.id, name: font.name }))
            : [],
          id: item.id,
          kind: item.kind,
          limits: {
            imageAllowedMimeTypes:
              packageCapabilities.image && item.image_max_bytes
                ? ["image/jpeg", "image/png", "image/webp"]
                : [],
            imageMaxBytes: packageCapabilities.image
              ? item.image_max_bytes
              : null,
            imageMaxHeightPx: null,
            imageMaxWidthPx: null,
            imageMinHeightPx: null,
            imageMinWidthPx: null,
            maxChars: packageCapabilities.text
              ? item.max_chars ?? item.default_max_chars
              : null,
            minChars: packageCapabilities.text ? item.min_chars : 0
          },
          name: item.label,
          priceDeltaCents: item.price_delta_cents,
          priceVariants: variantResult.rows
            .filter((variant) => variant.listing_customization_set_id === item.id)
            .map((variant) => ({
              currency: variant.currency,
              fontOptionId: null,
              id: variant.id,
              trimOptionId: variant.trim_option_id,
              unitAmountCents: variant.unit_amount_cents,
              variantKey: variant.variant_key
            })),
          requirements: {
            image: item.requires_image,
            text: item.requires_text,
            trim: item.requires_trim
          },
          trims: packageCapabilities.trim
            ? trimResult.rows
                .filter((trim) => trim.listing_customization_set_id === item.id)
                .map((trim) => ({
                  colorHex: trim.color_hex,
                  id: trim.id,
                  name: trim.name,
                  priceDeltaCents: trim.price_delta_cents,
                  widthMm: null
                }))
            : []
        };
      }),
      description: row.description,
      fabrics: fabricResult.rows.map((fabric) => ({
        availability: availability(true, fabric.available_quantity),
        colorHex: fabric.color_hex,
        id: fabric.id,
        image: media(fabric.image_url, fabric.image_alt),
        materialDescription: fabric.material,
        name: fabric.name
      })),
      gallery: galleryResult.rows.map((item) => ({ alt: item.alt, url: item.url })),
      policyNotice: UNPAID_CUSTOMIZATION_POLICY_NOTICE
    };
  }
}
