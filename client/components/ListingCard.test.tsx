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

type MockLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
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
  it("renders image, title, description, and base/from price labels", () => {
    const listing = createListing();
    const { rerender } = render(<ListingCard listing={listing} />);

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

    rerender(
      <ListingCard
        listing={createListing({
          basePriceCents: 22000,
          minPriceCents: 16000,
        })}
      />,
    );

    expect(screen.getByText("From $160.00")).toBeInTheDocument();
  });

  it("shows customization and fabric availability states", () => {
    render(
      <ListingCard
        listing={createListing({
          customizable: true,
          fabricAvailability: {
            availableQuantity: 3,
            label: "Ivory satin fabric",
          },
          listingType: "graduation_stole",
          lowStockThreshold: 4,
        })}
      />,
    );

    expect(screen.getByText("Customizable")).toBeInTheDocument();
    expect(screen.getByText("Low stock")).toBeInTheDocument();
    expect(screen.getByText("Ivory satin fabric")).toBeInTheDocument();
    expect(screen.getByText("3 available")).toBeInTheDocument();
  });

  it.each([
    { buttonName: "Unavailable", status: "unavailable" as const },
    { buttonName: "Archived", status: "archived" as const },
  ])(
    "disables add-to-cart for $status listings",
    async ({ buttonName, status }) => {
      const user = userEvent.setup();
      const handleAddToCart = vi.fn();

      render(
        <ListingCard
          listing={createListing({ status })}
          onAddToCart={handleAddToCart}
        />,
      );

      const addButton = screen.getByRole("button", { name: buttonName });

      expect(addButton).toBeDisabled();
      await user.click(addButton);
      expect(handleAddToCart).not.toHaveBeenCalled();
      expect(
        screen.getByText(`${buttonName} items cannot be added to cart.`),
      ).toBeInTheDocument();
    },
  );

  it("calls add-to-cart and exposes accessible detail links when enabled", async () => {
    const user = userEvent.setup();
    const listing = createListing();
    const handleAddToCart = vi.fn();

    render(
      <ListingCard
        addToCartLabel="Add graduation stole"
        detailsHref="/shop/ivory-graduation-stole"
        listing={listing}
        onAddToCart={handleAddToCart}
      />,
    );

    const imageLink = screen.getByRole("link", {
      name: "View details for Ivory Graduation Stole",
    });
    const addButton = screen.getByRole("button", {
      name: "Add graduation stole",
    });
    const detailsLink = screen.getByRole("link", { name: "View details" });

    expect(imageLink).toHaveAttribute("href", "/shop/ivory-graduation-stole");
    expect(detailsLink).toHaveAttribute("href", "/shop/ivory-graduation-stole");

    await user.tab();
    expect(imageLink).toHaveFocus();
    await user.tab();
    expect(addButton).toHaveFocus();
    await user.tab();
    expect(detailsLink).toHaveFocus();

    await user.click(addButton);
    expect(handleAddToCart).toHaveBeenCalledTimes(1);
    expect(handleAddToCart).toHaveBeenCalledWith(listing);
  });

  it.todo(
    "calls a customize action handler when the listing component exposes one",
  );

  it.todo(
    "calls a view-details action handler when the listing component exposes one",
  );
});
