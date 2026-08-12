"use client";

import Image from "next/image";
import Link from "next/link";

export type ListingStatus = "draft" | "active" | "archived" | "unavailable";

export type ListingAvailabilityStatus =
  | "available"
  | "low_stock"
  | "unavailable"
  | "unknown";

export type ListingCardListing = {
  availabilityStatus?: ListingAvailabilityStatus;
  basePriceCents: number;
  currency?: string;
  customizable?: boolean;
  id: string;
  imageAlt?: string | null;
  imageUrl?: string | null;
  minPriceCents?: number | null;
  shortDescription?: string | null;
  slug?: string | null;
  status?: ListingStatus;
  title: string;
};

export type ListingCardProps = {
  className?: string;
  detailsHref?: string;
  isAdminView?: boolean;
  listing: ListingCardListing;
};

function formatCurrency(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    currency,
    style: "currency",
  }).format(cents / 100);
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

function getStockLabel(status: ListingAvailabilityStatus) {
  if (status === "low_stock") {
    return "Low stock";
  }

  if (status === "unavailable") {
    return "Unavailable";
  }

  return null;
}

export function ListingCard({
  className,
  detailsHref,
  isAdminView = false,
  listing,
}: ListingCardProps) {
  const status = listing.status ?? "active";
  const availabilityStatus = listing.availabilityStatus ?? "unknown";
  const isArchived = status === "archived";
  const isDraft = status === "draft";
  const isUnavailable =
    availabilityStatus === "unavailable" ||
    status === "unavailable" ||
    isArchived;
  const stockLabel = getStockLabel(availabilityStatus);
  const adminStatusLabel =
    isAdminView && (isDraft || isArchived)
      ? isArchived
        ? "Archived"
        : "Draft"
      : null;

  return (
    <article
      className={`group relative flex h-full flex-col overflow-hidden rounded-lg border border-white/70 bg-white/90 shadow-[0_16px_48px_rgba(15,23,42,0.10)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_20px_56px_rgba(15,23,42,0.14)] focus-within:ring-2 focus-within:ring-[#b49872] focus-within:ring-offset-2 ${
        isUnavailable ? "border-slate-200/80 bg-white/75" : ""
      }${className ? ` ${className}` : ""}`}
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-slate-100">
        {listing.imageUrl ? (
          <Image
            src={listing.imageUrl}
            alt={listing.imageAlt ?? listing.title}
            fill
            sizes="(min-width: 1024px) 30vw, (min-width: 640px) 45vw, 92vw"
            className={`object-cover transition duration-300 group-hover:scale-[1.03] ${
              isUnavailable ? "opacity-55 grayscale" : "opacity-100"
            }`}
            unoptimized={listing.imageUrl.startsWith("http")}
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,rgba(180,152,114,0.20),rgba(255,255,255,0.92))] px-8 text-center">
            <span className="text-sm font-semibold uppercase text-[#8f734f]">
              Kapchi
            </span>
          </div>
        )}

        {stockLabel ? (
          <span className="pointer-events-none absolute left-3 top-3 z-10 rounded bg-white/95 px-2 py-1 text-xs font-semibold text-red-700 shadow-sm">
            {stockLabel}
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="line-clamp-2 min-w-0 break-words text-lg font-semibold text-slate-950">
            <Link
              href={getDetailsHref(listing, detailsHref)}
              className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
            >
              {listing.title}
            </Link>
          </h2>
          <p className="shrink-0 whitespace-nowrap text-sm font-semibold text-[#8f734f]">
            {getPriceLabel(listing)}
          </p>
        </div>

        <p className="line-clamp-2 text-sm leading-5 text-slate-600">
          {listing.shortDescription ??
            "Handcrafted Kapchi piece ready for a meaningful celebration."}
        </p>

        {listing.customizable || adminStatusLabel ? (
          <div className="mt-auto flex flex-wrap gap-2 pt-1 text-xs font-semibold">
            {listing.customizable ? (
              <span className="text-[#8f734f]">Customizable</span>
            ) : null}
            {adminStatusLabel ? (
              <span className="text-slate-500">{adminStatusLabel}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
