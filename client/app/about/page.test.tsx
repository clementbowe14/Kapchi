import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AboutPage from "./page";

vi.mock("@/components/about/AboutNavigation", () => ({
  AboutNavigation: () => <nav aria-label="Our story sections" />,
}));

describe("AboutPage", () => {
  it("pairs the founder story with Peru rather than a creator portrait", () => {
    render(<AboutPage />);

    const peruImage = screen.getByRole("img", {
      name: "Terraced fields and a village beneath the mountains of the Peruvian Andes.",
    });

    expect(peruImage.getAttribute("src")).toContain(
      encodeURIComponent("/images/about/peruvian-andes.jpg"),
    );
    expect(
      screen.getByText("The Peruvian Andes, where Kapchi’s story is rooted."),
    ).toBeInTheDocument();
    expect(
      screen.queryByAltText(/Bianca Poma.*smiling/i),
    ).not.toBeInTheDocument();
    const sentinel = document.getElementById("about-page-end");
    expect(sentinel?.tagName).toBe("SECTION");
    expect(document.querySelector("footer#about-page-end")).not.toBeInTheDocument();
  });
});
