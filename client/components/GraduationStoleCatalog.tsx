import { unstable_rethrow } from "next/navigation";
import { CatalogRetryButton } from "@/components/CatalogRetryButton";
import { ListingCard } from "@/components/ListingCard";
import {
  getGraduationStoleListings,
  type GraduationStoleSummary,
} from "@/lib/listings";

type CatalogState =
  | { items: GraduationStoleSummary[]; status: "ready" }
  | { status: "error" };

function toListingCardListing(listing: GraduationStoleSummary) {
  return {
    availabilityStatus: listing.availability.status,
    basePriceCents: listing.basePriceCents,
    currency: listing.currency,
    customizable: listing.isCustomizable,
    id: listing.id,
    imageAlt: listing.primaryImage?.alt,
    imageUrl: listing.primaryImage?.url,
    minPriceCents: listing.fromPriceCents,
    shortDescription: listing.subtitle,
    slug: listing.slug,
    status:
      listing.availability.status === "unavailable"
        ? ("unavailable" as const)
        : ("active" as const),
    title: listing.title,
  };
}

export function GraduationStoleCatalogSection({ state }: { state: CatalogState }) {
  return (
    <section
      aria-labelledby="graduation-stoles-heading"
      className="border-t border-black/10 bg-[#f8f7f4] py-10 sm:py-14"
      id="graduation-stoles"
    >
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <header className="max-w-2xl">
          <p className="text-xs font-semibold uppercase text-[#8f734f]">
            Made for your milestone
          </p>
          <h2
            className="mt-2 text-2xl font-semibold leading-tight text-[#171614] sm:text-3xl"
            id="graduation-stoles-heading"
          >
            Graduation stoles
          </h2>
          <p className="mt-3 leading-7 text-slate-600">
            Choose a woven stole, explore available fabrics, and select the
            customizations that fit your celebration.
          </p>
        </header>

        {state.status === "error" ? (
          <div
            className="mt-8 border-y border-red-200 py-10 text-center"
            role="alert"
          >
            <h3 className="text-lg font-semibold text-slate-950">
              The graduation stole catalog is temporarily unavailable
            </h3>
            <p className="mt-2 text-slate-600">
              The rest of Kapchi is still available. Please try loading the
              catalog again.
            </p>
            <CatalogRetryButton />
          </div>
        ) : state.items.length ? (
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {state.items.map((listing) => (
              <ListingCard
                key={listing.id}
                listing={toListingCardListing(listing)}
              />
            ))}
          </div>
        ) : (
          <div className="mt-8 border-y border-slate-200 py-12 text-center">
            <h3 className="text-lg font-semibold text-slate-950">
              No graduation stoles are available yet
            </h3>
            <p className="mt-2 text-slate-600">
              Please check back as new fabrics and designs are published.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

export function GraduationStoleCatalogSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-labelledby="graduation-stoles-loading-heading"
      className="border-t border-black/10 bg-[#f8f7f4] py-10 sm:py-14"
      id="graduation-stoles"
    >
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <p className="text-xs font-semibold uppercase text-[#8f734f]">
          Made for your milestone
        </p>
        <h2
          className="mt-2 text-2xl font-semibold text-[#171614] sm:text-3xl"
          id="graduation-stoles-loading-heading"
        >
          Graduation stoles
        </h2>
        <p className="sr-only">Loading graduation stoles</p>
        <div
          aria-hidden="true"
          className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
        >
          {[0, 1, 2].map((item) => (
            <div className="overflow-hidden border border-slate-200 bg-white" key={item}>
              <div className="aspect-[4/3] animate-pulse bg-slate-200" />
              <div className="space-y-3 p-4">
                <div className="h-5 w-3/4 animate-pulse bg-slate-200" />
                <div className="h-4 w-1/2 animate-pulse bg-slate-100" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export async function GraduationStoleCatalog() {
  let state: CatalogState;

  try {
    const { items } = await getGraduationStoleListings();
    state = { items, status: "ready" };
  } catch (error) {
    unstable_rethrow(error);
    console.error("Failed to load the homepage graduation stole catalog", error);
    state = { status: "error" };
  }

  return <GraduationStoleCatalogSection state={state} />;
}
