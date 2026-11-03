import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NavbarAuth } from "./NavbarAuth";

const authState = vi.hoisted(() => ({
  isSignedIn: false,
  user: null as null | { firstName: string },
}));

vi.mock("@clerk/nextjs", () => ({
  ClerkLoaded: ({ children }: { children: ReactNode }) => <>{children}</>,
  ClerkLoading: () => null,
  SignOutButton: ({ children }: { children: ReactNode }) => <>{children}</>,
  UserButton: () => <span>User menu</span>,
  useUser: () => authState,
}));

describe("NavbarAuth", () => {
  beforeEach(() => {
    authState.isSignedIn = false;
    authState.user = null;
  });

  it("does not advertise admin orders to signed-out visitors", () => {
    render(<NavbarAuth />);
    expect(screen.getByRole("link", { name: "Sign In" })).toHaveAttribute("href", "/sign-in");
    expect(screen.queryByRole("link", { name: "Admin orders" })).not.toBeInTheDocument();
  });

  it("gives signed-in users a backend-authorized admin entry point", () => {
    authState.isSignedIn = true;
    authState.user = { firstName: "Maya" };
    render(<NavbarAuth />);
    expect(screen.getByRole("link", { name: "Admin orders" })).toHaveAttribute("href", "/admin/orders");
  });

  it("closes the mobile menu after navigating to admin orders", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    authState.isSignedIn = true;
    authState.user = { firstName: "Maya" };
    render(<NavbarAuth mobile onNavigate={onNavigate} />);
    await user.click(screen.getByRole("link", { name: "Admin orders" }));
    expect(onNavigate).toHaveBeenCalledOnce();
  });
});
