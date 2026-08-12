import { notFound } from "next/navigation";
import { StoleConfigurator } from "@/components/StoleConfigurator";
import { getGraduationStoleBySlug, ListingApiError } from "@/lib/listings";

async function loadListing(slug: string) {
  try {
    return await getGraduationStoleBySlug(slug);
  } catch (error) {
    if (error instanceof ListingApiError && error.status === 404) notFound();
    throw error;
  }
}

export default async function ListingDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const listing = await loadListing(slug);
  return <StoleConfigurator listing={listing} />;
}
