import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AnchorHTMLAttributes,
  ImgHTMLAttributes,
  ReactNode,
} from "react";
import { describe, expect, it, vi } from "vitest";

import { ListingCard, type ListingCardListing } from "./ListingCard";

type MockImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  alt: string;
  fill?: boolean;
  sizes?: string;
  src: string | { src: string };
  unoptimized?: boolean;
};

vi.mock("next/image", () => ({
  default: ({ alt, className, src }: MockImageProps) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={alt}
      className={className}
      src={typeof src === "string" ? src : src.src}
    />
  ),
}));

type MockLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  children: ReactNode;
  href: string | { pathname?: string };
};

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: MockLinkProps) => (
    <a href={typeof href === "string" ? href : href.pathname ?? "#"} {...props}>
      {children}
    </a>
  ),
}));

function createListing(
  overrides: Partial<ListingCardListing> = {},
): ListingCardListing {
  return {
    availabilityStatus: "available",
    basePriceCents: 18000,
    currency: "USD",
    customizable: false,
    id: "listing-1",
    imageAlt: "Ivory graduation stole with gold embroidery",
    imageUrl: "https://example.com/ivory-stole.jpg",
    shortDescription:
      "An heirloom graduation stole with embroidered trim and satin lining.",
    slug: "ivory-graduation-stole",
    status: "active",
    title: "Ivory Graduation Stole",
    ...overrides,
  };
}

describe("ListingCard", () => {
  it("uses one accessible detail link as the card's only focus target", async () => {
    const user = userEvent.setup();

    render(
      <ListingCard
        detailsHref="/shop/ivory-graduation-stole"
        listing={createListing()}
      />,
    );

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName("Ivory Graduation Stole");
    expect(links[0]).toHaveAttribute("href", "/shop/ivory-graduation-stole");
    expect(links[0]).toHaveClass("after:absolute", "after:inset-0");

    await user.tab();
    expect(links[0]).toHaveFocus();
    await user.tab();
    expect(links[0]).not.toHaveFocus();
  });

  it("renders the image, alt text, description, and base price", () => {
    const listing = createListing();
    render(<ListingCard listing={listing} />);

    expect(
      screen.getByRole("img", {
        name: "Ivory graduation stole with gold embroidery",
      }),
    ).toHaveAttribute("src", listing.imageUrl);
    expect(
      screen.getByRole("heading", { name: "Ivory Graduation Stole" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "An heirloom graduation stole with embroidered trim and satin lining.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("$180.00")).toBeInTheDocument();
  });

  it("uses the minimum price only when it differs from the base price", () => {
    const { rerender } = render(
      <ListingCard
        listing={createListing({
          basePriceCents: 22000,
          minPriceCents: 16000,
        })}
      />,
    );

    expect(screen.getByText("From $160.00")).toBeInTheDocument();

    rerender(
      <ListingCard
        listing={createListing({
          basePriceCents: 22000,
          minPriceCents: 22000,
        })}
      />,
    );

    expect(screen.getByText("$220.00")).toBeInTheDocument();
    expect(screen.queryByText(/From/)).not.toBeInTheDocument();
  });

  it.each([
    { availabilityStatus: "available" as const, expectedLabel: null },
    { availabilityStatus: "low_stock" as const, expectedLabel: "Low stock" },
    {
      availabilityStatus: "unavailable" as const,
      expectedLabel: "Unavailable",
    },
    { availabilityStatus: "unknown" as const, expectedLabel: null },
  ])(
    "renders semantic $availabilityStatus availability without quantities",
    ({ availabilityStatus, expectedLabel }) => {
      const listingWithLegacyInventory = {
        ...createListing({ availabilityStatus }),
        availableQuantity: 3,
        fabricAvailability: {
          availableQuantity: 3,
          label: "Ivory satin fabric",
        },
      };

      render(<ListingCard listing={listingWithLegacyInventory} />);

      if (expectedLabel) {
        expect(screen.getByText(expectedLabel)).toBeInTheDocument();
      } else {
        expect(screen.queryByText("Low stock")).not.toBeInTheDocument();
        expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
      }

      expect(screen.queryByText("3 available")).not.toBeInTheDocument();
      expect(screen.queryByText("Ivory satin fabric")).not.toBeInTheDocument();
    },
  );

  it("styles unavailable listings without adding another interaction", () => {
    render(
      <ListingCard
        listing={createListing({ availabilityStatus: "unavailable" })}
      />,
    );

    expect(screen.getByRole("img")).toHaveClass("opacity-55", "grayscale");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("keeps compact customization and admin lifecycle signals", () => {
    const { rerender } = render(
      <ListingCard
        isAdminView
        listing={createListing({ customizable: true, status: "draft" })}
      />,
    );

    expect(screen.getByText("Customizable")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();

    rerender(
      <ListingCard
        isAdminView
        listing={createListing({ status: "archived" })}
      />,
    );

    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveClass("opacity-55", "grayscale");
  });

  it("uses a compact body while preserving the image aspect ratio", () => {
    const { container } = render(<ListingCard listing={createListing()} />);
    const article = container.querySelector("article");
    const imageRegion = screen.getByRole("img").parentElement;

    expect(article).toHaveClass("rounded-lg", "focus-within:ring-2");
    expect(article).not.toHaveClass("min-h-[31rem]");
    expect(imageRegion).toHaveClass("aspect-[4/3]");
    expect(screen.getByRole("heading")).toHaveClass("line-clamp-2");
    expect(
      screen.getByText(/An heirloom graduation stole/),
    ).toHaveClass("line-clamp-2");
  });

  it("does not render listing action controls or action copy", () => {
    render(<ListingCard listing={createListing()} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("Add to cart")).not.toBeInTheDocument();
    expect(screen.queryByText("View details")).not.toBeInTheDocument();
  });

  it("falls back to the listing title for image alt text and to Kapchi art", () => {
    const { rerender } = render(
      <ListingCard listing={createListing({ imageAlt: null })} />,
    );

    expect(
      screen.getByRole("img", { name: "Ivory Graduation Stole" }),
    ).toBeInTheDocument();

    rerender(
      <ListingCard listing={createListing({ imageAlt: null, imageUrl: null })} />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Kapchi")).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
