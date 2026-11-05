import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StorePolicyFooter } from "@/components/StorePolicyFooter";
import { findPolicy, PolicyPage } from "./policy-page";

describe("store policy pages", () => {
  it("renders current draft content with version evidence and related links", () => {
    render(<PolicyPage policyKey="shipping" />);
    expect(screen.getByRole("heading", { level: 1, name: "Shipping and Production Policy" })).toBeInTheDocument();
    expect(screen.getByText(/Draft for owner review/)).toBeInTheDocument();
    expect(screen.getByText("2026-11-03.1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Terms of Sale" })).toHaveAttribute("href", "/policies/terms");
  });

  it("resolves an exact archive and rejects unknown keys or versions", () => {
    expect(findPolicy("returns", "2026-11-03.1")?.document.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(findPolicy("unknown", "2026-11-03.1")).toBeNull();
    expect(findPolicy("returns", "2099-01-01.1")).toBeNull();
  });

  it("provides all policy links in the global footer", () => {
    render(<StorePolicyFooter />);
    expect(screen.getAllByRole("link")).toHaveLength(4);
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/policies/privacy");
  });
});
