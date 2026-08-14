import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cartInvalidationStorageKey } from "@/lib/cart-state";
import { Navbar } from "./Navbar";

const authState = vi.hoisted(() => ({
  getToken: vi.fn(),
  isLoaded: true,
  isSignedIn: false,
  userId: null as string | null,
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => authState,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span aria-label={alt || undefined} />,
}));

vi.mock("@/components/NavbarAuth", () => ({
  NavbarAuth: () => <div data-testid="navbar-auth" />,
}));

vi.mock("@/components/MobileMenu", () => ({
  MobileMenu: ({ cartCount }: { cartCount: number | null }) => (
    <div data-testid="mobile-cart-count">{cartCount ?? "unknown"}</div>
  ),
}));

function summary(totalQuantity: number, revision = 1) {
  return new Response(
    JSON.stringify({
      cartId: totalQuantity > 0 ? "cart-1" : undefined,
      lineItemCount: totalQuantity > 0 ? 1 : 0,
      revision,
      subtotalCents: totalQuantity * 8500,
      totalQuantity,
    }),
    { headers: { "Content-Type": "application/json" }, status: 200 },
  );
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe("Navbar cart count", () => {
  beforeEach(() => {
    authState.getToken.mockReset();
    authState.getToken.mockResolvedValue("clerk-token");
    authState.isLoaded = true;
    authState.isSignedIn = false;
    authState.userId = null;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { setItem: vi.fn() },
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  it("hydrates an existing cart on reload using the total physical quantity", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(summary(3));

    render(<Navbar />);

    expect(await screen.findByLabelText("Cart with 3 items")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-cart-count")).toHaveTextContent("3");
    expect(fetch).toHaveBeenCalledWith(
      "/api/cart/summary",
      expect.objectContaining({
        cache: "no-store",
        credentials: "include",
      }),
    );
  });

  it("ignores a stale summary response", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    vi.mocked(fetch)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render(<Navbar />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve(summary(4, 2)));
    expect(await screen.findByLabelText("Cart with 4 items")).toBeInTheDocument();
    await act(async () => first.resolve(summary(1, 1)));
    expect(screen.getByLabelText("Cart with 4 items")).toBeInTheDocument();
  });

  it("revalidates on focus and privacy-safe cross-tab invalidation", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(summary(1, 1))
      .mockResolvedValueOnce(summary(2, 2))
      .mockResolvedValueOnce(summary(3, 3));

    render(<Navbar />);
    expect(await screen.findByLabelText("Cart with 1 item")).toBeInTheDocument();

    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByLabelText("Cart with 2 items")).toBeInTheDocument();

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: cartInvalidationStorageKey,
        newValue: "opaque-token",
      }),
    );
    expect(await screen.findByLabelText("Cart with 3 items")).toBeInTheDocument();
  });

  it("clears the previous identity count and authenticates account summaries", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(summary(2, 1))
      .mockResolvedValueOnce(summary(5, 1));
    const view = render(<Navbar />);
    expect(await screen.findByLabelText("Cart with 2 items")).toBeInTheDocument();

    authState.isSignedIn = true;
    authState.userId = "user-1";
    view.rerender(<Navbar />);

    expect(await screen.findByLabelText("Cart with 5 items")).toBeInTheDocument();
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/cart/summary",
      expect.objectContaining({
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
  });
});
