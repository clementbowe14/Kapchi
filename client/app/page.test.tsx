import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Home from "./page";

vi.mock("@/components/HeroCarousel", () => ({
  HeroCarousel: ({
    primaryAction,
  }: {
    primaryAction?: { href: string; label: string };
  }) => (
    <section data-testid="hero">
      {primaryAction ? (
        <a href={primaryAction.href}>{primaryAction.label}</a>
      ) : null}
    </section>
  ),
}));

vi.mock("@/components/GraduationStoleCatalog", () => ({
  GraduationStoleCatalog: () => <section data-testid="catalog" />,
  GraduationStoleCatalogSkeleton: () => <section data-testid="skeleton" />,
}));

describe("Home", () => {
  it("places the catalog directly below the hero and retains following content", () => {
    render(<Home />);

    const hero = screen.getByTestId("hero");
    const catalog = screen.getByTestId("catalog");
    const craftsmanship = screen.getByRole("heading", {
      name: "Stoles that honor where you come from and where you are going.",
    });

    expect(hero.compareDocumentPosition(catalog)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(catalog.compareDocumentPosition(craftsmanship)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("links the hero shop action to the homepage catalog", () => {
    render(<Home />);

    expect(
      screen.getByRole("link", { name: "Shop graduation stoles" }),
    ).toHaveAttribute("href", "/#graduation-stoles");
  });
});
