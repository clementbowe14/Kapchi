import { ListingCard } from "@/components/ListingCard";
import { getGraduationStoleListings } from "@/lib/listings";

export default async function ListingsPage() {
  const { items } = await getGraduationStoleListings();

  return (
    <main className="flex-1 bg-white">
      <header className="border-b border-slate-200 px-4 py-12 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <p className="text-xs font-semibold uppercase text-[#8f734f]">Made for your milestone</p>
          <h1 className="mt-3 text-4xl font-semibold text-slate-950">Graduation stoles</h1>
          <p className="mt-4 max-w-2xl leading-7 text-slate-600">Choose a woven stole, explore available fabrics, and select only the customizations that fit your celebration.</p>
        </div>
      </header>
      <section aria-labelledby="catalog-heading" className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <h2 className="sr-only" id="catalog-heading">Available graduation stoles</h2>
        {items.length ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((listing) => (
              <ListingCard
                key={listing.id}
                listing={{
                  basePriceCents: listing.basePriceCents,
                  currency: listing.currency,
                  customizable: listing.isCustomizable,
                  fabricAvailability: listing.availability,
                  id: listing.id,
                  imageAlt: listing.primaryImage?.alt,
                  imageUrl: listing.primaryImage?.url,
                  listingType: listing.listingType,
                  minPriceCents: listing.fromPriceCents,
                  shortDescription: listing.subtitle,
                  slug: listing.slug,
                  status: listing.availability.status === "unavailable" ? "unavailable" : "active",
                  title: listing.title,
                }}
              />
            ))}
          </div>
        ) : (
          <div className="border-y border-slate-200 py-16 text-center">
            <h2 className="text-xl font-semibold text-slate-950">No graduation stoles are available yet</h2>
            <p className="mt-2 text-slate-600">Please check back as new fabrics and designs are published.</p>
          </div>
        )}
      </section>
    </main>
  );
}
