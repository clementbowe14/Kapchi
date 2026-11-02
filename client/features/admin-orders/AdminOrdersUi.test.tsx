import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadingPanel, StatusBadge } from "./AdminOrdersUi";

describe("admin order shared UI", () => {
  it("does not give unpaid orders a success treatment", () => {
    const { rerender } = render(<StatusBadge value="unpaid" />);
    expect(screen.getByText("Unpaid")).toHaveClass("text-amber-800");

    rerender(<StatusBadge value="paid" />);
    expect(screen.getByText("Paid")).toHaveClass("text-emerald-700");
  });

  it("announces fixed-dimension loading skeletons", () => {
    render(<LoadingPanel label="Loading order detail" variant="detail" />);
    expect(screen.getByRole("status", { name: "Loading order detail" })).toHaveClass("min-h-80");
  });
});
