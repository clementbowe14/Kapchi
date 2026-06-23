"use client";

import Image from "next/image";
import Link from "next/link";

export type ListingStatus = "draft" | "active" | "archived" | "unavailable";

export type ListingType = "graduation_stole" | "accessory" | "other";

export type ListingFabricAvailability = {
  availableQuantity?: number | null;
  label?: string | null;
  quantityOnHand?: number | null;
  quantityReserved?: number | null;
};

export type ListingCardListing = {
  availableQuantity?: number | null;
  basePriceCents: number;
  currency?: string;
  customizable?: boolean;
  fabricAvailability?: ListingFabricAvailability | null;
  id: string;
  imageAlt?: string | null;
  imageUrl?: string | null;
  listingType?: ListingType;
  lowStockThreshold?: number;
  minPriceCents?: number | null;
  quantityOnHand?: number | null;
  quantityReserved?: number | null;
  requiresFabric?: boolean;
  shortDescription?: string | null;
  slug?: string | null;
  status?: ListingStatus;
  title: string;
};

export type ListingCardProps = {
  addToCartLabel?: string;
  className?: string;
  detailsHref?: string;
  isAdminView?: boolean;
  listing: ListingCardListing;
  onAddToCart?: (listing: ListingCardListing) => void;
};

function formatCurrency(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    currency,
    style: "currency",
  }).format(cents / 100);
}

function getAvailableQuantity(
  availability?: ListingFabricAvailability | null,
) {
  if (!availability) {
    return null;
  }

  if (typeof availability.availableQuantity === "number") {
    return Math.max(0, availability.availableQuantity);
  }

  const quantityOnHand =
    typeof availability.quantityOnHand === "number"
      ? availability.quantityOnHand
      : null;
  const quantityReserved =
    typeof availability.quantityReserved === "number"
      ? availability.quantityReserved
      : 0;

  if (quantityOnHand === null) {
    return null;
  }

  return Math.max(0, quantityOnHand - quantityReserved);
}

function getListingAvailableQuantity(listing: ListingCardListing) {
  return getAvailableQuantity({
    availableQuantity: listing.availableQuantity,
    quantityOnHand: listing.quantityOnHand,
    quantityReserved: listing.quantityReserved,
  });
}

function getDetailsHref(listing: ListingCardListing, detailsHref?: string) {
  if (detailsHref) {
    return detailsHref;
  }

  return `/listings/${listing.slug ?? listing.id}`;
}

function getPriceLabel(listing: ListingCardListing) {
  const priceCents = listing.minPriceCents ?? listing.basePriceCents;
  const prefix =
    typeof listing.minPriceCents === "number" &&
    listing.minPriceCents !== listing.basePriceCents
      ? "From "
      : "";

  return `${prefix}${formatCurrency(priceCents, listing.currency)}`;
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: string;
  tone?: "gold" | "muted" | "neutral" | "warning";
}) {
  const toneClasses = {
    gold: "border-[#b49872]/25 bg-[#b49872]/12 text-[#8f734f]",
    muted: "border-slate-200 bg-slate-50 text-slate-500",
    neutral: "border-white/70 bg-white/75 text-slate-700",
    warning: "border-amber-200 bg-amber-50 text-amber-700",
  };

  return (
    <span
      className={`inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-semibold ${toneClasses[tone]}`}
    >
      {children}
    </span>
  );
}

export function ListingCard({
  addToCartLabel = "Add to cart",
  className,
  detailsHref,
  isAdminView = false,
  listing,
  onAddToCart,
}: ListingCardProps) {
  const status = listing.status ?? "active";
  const isArchived = status === "archived";
  const isUnavailable = status === "unavailable" || isArchived;
  const isDraft = status === "draft";
  const fabricAvailableQuantity = getAvailableQuantity(
    listing.fabricAvailability,
  );
  const listingAvailableQuantity = getListingAvailableQuantity(listing);
  const showsFabricAvailability =
    listing.listingType === "graduation_stole" || listing.requiresFabric;
  const stockQuantity = showsFabricAvailability
    ? fabricAvailableQuantity
    : listingAvailableQuantity;
  const fabricUnavailable =
    showsFabricAvailability &&
    typeof fabricAvailableQuantity === "number" &&
    fabricAvailableQuantity < 1;
  const listingUnavailable =
    !showsFabricAvailability &&
    typeof listingAvailableQuantity === "number" &&
    listingAvailableQuantity < 1;
  const lowStockThreshold = listing.lowStockThreshold ?? 4;
  const isLowStock =
    !isUnavailable &&
    typeof stockQuantity === "number" &&
    stockQuantity > 0 &&
    stockQuantity <= lowStockThreshold;
  const canAddToCart =
    !isUnavailable &&
    !isDraft &&
    !fabricUnavailable &&
    !listingUnavailable &&
    Boolean(onAddToCart);
  const disabledReason = isArchived
    ? "Archived"
    : isDraft
      ? "Coming soon"
      : fabricUnavailable
        ? "Fabric unavailable"
        : listingUnavailable || status === "unavailable"
          ? "Unavailable"
          : null;

  const badges = [
    listing.customizable ? (
      <Badge key="customizable" tone="gold">
        Customizable
      </Badge>
    ) : null,
    isLowStock ? (
      <Badge key="low-stock" tone="warning">
        Low stock
      </Badge>
    ) : null,
    isUnavailable || fabricUnavailable || listingUnavailable ? (
      <Badge key="unavailable" tone="muted">
        Unavailable
      </Badge>
    ) : null,
    isAdminView && isArchived ? (
      <Badge key="archived" tone="muted">
        Archived
      </Badge>
    ) : null,
  ].filter(Boolean);

  return (
    <article
      className={`group flex h-full min-h-[31rem] flex-col overflow-hidden rounded-[1.75rem] border border-white/70 bg-white/88 shadow-[0_22px_70px_rgba(15,23,42,0.10)] backdrop-blur-xl transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_26px_80px_rgba(15,23,42,0.14)] ${
        isUnavailable || fabricUnavailable || listingUnavailable
          ? "border-slate-200/80 bg-white/70"
          : ""
      }${className ? ` ${className}` : ""}`}
    >
      <Link
        href={getDetailsHref(listing, detailsHref)}
        className="relative block aspect-[4/3] overflow-hidden bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-inset"
        aria-label={`View details for ${listing.title}`}
      >
        {listing.imageUrl ? (
          <Image
            src={listing.imageUrl}
            alt={listing.imageAlt ?? listing.title}
            fill
            sizes="(min-width: 1024px) 30vw, (min-width: 640px) 45vw, 92vw"
            className={`object-cover transition duration-300 group-hover:scale-[1.03] ${
              isUnavailable || fabricUnavailable || listingUnavailable
                ? "opacity-55 grayscale"
                : "opacity-100"
            }`}
            unoptimized={listing.imageUrl.startsWith("http")}
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,rgba(180,152,114,0.20),rgba(255,255,255,0.92))] px-8 text-center">
            <span className="text-sm font-semibold uppercase tracking-[0.24em] text-[#8f734f]">
              Kapchi
            </span>
          </div>
        )}
      </Link>

      <div className="flex flex-1 flex-col gap-5 p-5 sm:p-6">
        <div className="flex min-h-[2rem] flex-wrap gap-2">
          {badges.length > 0 ? badges : <span aria-hidden="true" />}
        </div>

        <div className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <h2 className="min-w-0 break-words text-xl font-semibold tracking-tight text-slate-950">
              {listing.title}
            </h2>
            <p className="shrink-0 text-base font-semibold text-[#8f734f]">
              {getPriceLabel(listing)}
            </p>
          </div>
          {listing.shortDescription ? (
            <p className="line-clamp-3 min-h-[4.5rem] text-sm leading-6 text-slate-600">
              {listing.shortDescription}
            </p>
          ) : (
            <p className="line-clamp-3 min-h-[4.5rem] text-sm leading-6 text-slate-500">
              Handcrafted Kapchi piece ready for a meaningful celebration.
            </p>
          )}
        </div>

        {showsFabricAvailability ? (
          <div className="rounded-2xl border border-slate-200/80 bg-slate-50/80 px-4 py-3 text-sm text-slate-700">
            <p className="font-medium text-slate-900">
              {listing.fabricAvailability?.label ?? "Graduation stole fabric"}
            </p>
            <p className="mt-1 text-slate-500">
              {typeof fabricAvailableQuantity === "number"
                ? fabricAvailableQuantity > 0
                  ? `${fabricAvailableQuantity} available`
                  : "No fabric currently available"
                : "Availability confirmed at checkout"}
            </p>
          </div>
        ) : null}

        {disabledReason ? (
          <p className="mt-auto text-sm font-medium text-slate-500">
            {disabledReason} items cannot be added to cart.
          </p>
        ) : (
          <div className="mt-auto" />
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
          <button
            type="button"
            disabled={!canAddToCart}
            onClick={() => {
              if (canAddToCart) {
                onAddToCart?.(listing);
              }
            }}
            className="inline-flex h-12 items-center justify-center rounded-full bg-[#b49872] px-5 text-sm font-semibold text-white shadow-[0_16px_34px_rgba(143,115,79,0.24)] transition hover:bg-[#a1845f] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2"
          >
            {disabledReason ?? addToCartLabel}
          </button>
          <Link
            href={getDetailsHref(listing, detailsHref)}
            className="inline-flex h-12 items-center justify-center rounded-full border border-slate-200 bg-white/85 px-5 text-sm font-semibold text-slate-800 transition hover:border-[#b49872]/50 hover:text-[#8f734f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2"
          >
            View details
          </Link>
        </div>
      </div>
    </article>
  );
}
