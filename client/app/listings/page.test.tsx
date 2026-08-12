import { beforeEach, describe, expect, it, vi } from "vitest";
import ListingsPage from "./page";

const permanentRedirect = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ permanentRedirect }));

describe("ListingsPage", () => {
  beforeEach(() => {
    permanentRedirect.mockReset();
  });

  it("permanently redirects collection URLs to the homepage catalog", () => {
    ListingsPage();

    expect(permanentRedirect).toHaveBeenCalledOnce();
    expect(permanentRedirect).toHaveBeenCalledWith("/#graduation-stoles");
  });
});
