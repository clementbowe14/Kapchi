import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraduationStoleSummary } from "@/lib/listings";
import {
  GraduationStoleCatalog,
  GraduationStoleCatalogSection,
  GraduationStoleCatalogSkeleton,
} from "./GraduationStoleCatalog";

const mocks = vi.hoisted(() => ({
  getGraduationStoleListings: vi.fn(),
  refresh: vi.fn(),
  listingCard: vi.fn(
    ({ listing }: { listing: Record<string, unknown> }) => (
      <a
        data-availability={listing.availabilityStatus}
        href={`/listings/${listing.slug}`}
      >
        {String(listing.title)}
      </a>
    ),
  ),
}));

vi.mock("@/lib/listings", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/listings")>();

  return {
    ...original,
    getGraduationStoleListings: mocks.getGraduationStoleListings,
  };
});

vi.mock("@/components/ListingCard", () => ({
  ListingCard: mocks.listingCard,
}));

vi.mock("next/navigation", () => ({
  unstable_rethrow: vi.fn(),
  useRouter: () => ({ refresh: mocks.refresh }),
}));

const listing: GraduationStoleSummary = {
  availability: {
    availableQuantity: 5,
    label: null,
    status: "low_stock",
  },
  basePriceCents: 15_000,
  currency: "USD",
  fromPriceCents: 15_000,
  id: "listing-1",
  isCustomizable: true,
  listingType: "graduation_stole",
  primaryImage: {
    alt: "Red and gold graduation stole",
    url: "/images/stole.webp",
  },
  slug: "classic-graduation-stole",
  subtitle: "A woven stole for graduation day.",
  title: "Classic graduation stole",
};

beforeEach(() => {
  mocks.getGraduationStoleListings.mockReset();
  mocks.listingCard.mockClear();
  mocks.refresh.mockReset();
});

describe("GraduationStoleCatalogSection", () => {
  it("renders populated listings using semantic availability without quantity data", () => {
    render(
      <GraduationStoleCatalogSection
        state={{ items: [listing], status: "ready" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Graduation stoles" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: listing.title }),
    ).toHaveAttribute("data-availability", "low_stock");
    expect(mocks.listingCard).toHaveBeenCalledOnce();

    const cardListing = mocks.listingCard.mock.calls[0][0].listing;
    expect(cardListing).not.toHaveProperty("availableQuantity");
    expect(cardListing).not.toHaveProperty("fabricAvailability");
  });

  it("renders an accessible empty state", () => {
    render(
      <GraduationStoleCatalogSection state={{ items: [], status: "ready" }} />,
    );

    expect(
      screen.getByRole("heading", {
        name: "No graduation stoles are available yet",
      }),
    ).toBeInTheDocument();
    expect(mocks.listingCard).not.toHaveBeenCalled();
  });

  it("renders an accessible inline error without replacing the section", () => {
    render(<GraduationStoleCatalogSection state={{ status: "error" }} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The graduation stole catalog is temporarily unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("heading", { name: "Graduation stoles" }),
    ).toBeInTheDocument();
  });
});

describe("GraduationStoleCatalog", () => {
  it("loads listings through the existing server-side catalog client", async () => {
    mocks.getGraduationStoleListings.mockResolvedValue({
      items: [listing],
      requestId: "request-1",
    });

    render(await GraduationStoleCatalog());

    expect(mocks.getGraduationStoleListings).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: listing.title })).toBeInTheDocument();
  });

  it("contains a failed request inside the catalog section", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.getGraduationStoleListings.mockRejectedValue(
      new Error("backend unavailable"),
    );

    render(await GraduationStoleCatalog());

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to load the homepage graduation stole catalog",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});

describe("GraduationStoleCatalogSkeleton", () => {
  it("reserves stable card image and compact body space while loading", () => {
    const { container } = render(<GraduationStoleCatalogSkeleton />);

    expect(screen.getByText("Loading graduation stoles")).toBeInTheDocument();
    expect(container.querySelectorAll(".aspect-\\[4\\/3\\]")).toHaveLength(3);
    expect(container.querySelector("section")).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });
});
