"use client";

import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MobileMenu } from "@/components/MobileMenu";
import { NavbarAuth } from "@/components/NavbarAuth";
import { CartIcon } from "@/components/NavIcons";
import { NAV_ITEMS } from "@/lib/navigation";

type NavbarProps = {
  cartCount?: number;
};

function Brand() {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-3 rounded-full px-2 py-1.5 transition hover:bg-white/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2"
      aria-label="Kapchi home"
    >
      <span className="relative h-11 w-11 overflow-hidden rounded-full border border-white/60 bg-white/70 shadow-[0_10px_24px_rgba(15,23,42,0.08)]">
        <Image
          src="/kapchi_logo.png"
          alt=""
          fill
          sizes="44px"
          className="object-cover"
          priority
        />
      </span>
      <span className="hidden text-lg font-semibold tracking-tight text-[#b49872] sm:block">
        Kapchi
      </span>
    </Link>
  );
}

function HamburgerButton({
  controls,
  open,
  onClick,
}: {
  controls: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={open ? "Close navigation menu" : "Open navigation menu"}
      aria-controls={controls}
      aria-expanded={open}
      onClick={onClick}
      className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/65 bg-white/75 text-slate-900 shadow-[0_10px_24px_rgba(15,23,42,0.08)] backdrop-blur transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2"
    >
      <span className="relative h-4 w-5">
        <span
          className={`absolute left-0 top-0 h-0.5 w-5 rounded-full bg-current transition ${
            open ? "translate-y-[7px] rotate-45" : ""
          }`}
        />
        <span
          className={`absolute left-0 top-[7px] h-0.5 w-5 rounded-full bg-current transition ${
            open ? "opacity-0" : ""
          }`}
        />
        <span
          className={`absolute left-0 top-[14px] h-0.5 w-5 rounded-full bg-current transition ${
            open ? "-translate-y-[7px] -rotate-45" : ""
          }`}
        />
      </span>
    </button>
  );
}

function DesktopNavLink({
  active,
  children,
  href,
}: {
  active?: boolean;
  children: ReactNode;
  href: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`inline-flex h-11 items-center rounded-full px-4 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2 ${
        active
          ? "bg-[#b49872]/14 text-[#8f734f]"
          : "text-slate-700 hover:bg-white/60 hover:text-slate-950"
      }`}
    >
      {children}
    </Link>
  );
}

function CartLink({
  active,
  cartCount = 0,
}: {
  active?: boolean;
  cartCount?: number;
}) {
  return (
    <Link
      href="/cart"
      aria-label={cartCount > 0 ? `Cart with ${cartCount} items` : "Cart"}
      aria-current={active ? "page" : undefined}
      className={`relative inline-flex h-11 items-center gap-2 rounded-full px-4 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2 ${
        active
          ? "bg-[#b49872]/14 text-[#8f734f]"
          : "text-slate-700 hover:bg-white/60 hover:text-slate-950"
      }`}
    >
      <CartIcon className="h-5 w-5" />
      <span>Cart</span>
      {cartCount > 0 ? (
        <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-[#b49872] px-1.5 py-0.5 text-[11px] font-semibold text-white">
          {cartCount}
        </span>
      ) : null}
    </Link>
  );
}

export function Navbar({ cartCount = 0 }: NavbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [visibleCartCount, setVisibleCartCount] = useState(cartCount);
  const pathname = usePathname();
  const menuId = useId();

  useEffect(() => {
    const updateCartCount = (event: Event) => {
      const detail = (event as CustomEvent<{ count?: unknown }>).detail;
      if (
        typeof detail?.count === "number" &&
        Number.isInteger(detail.count) &&
        detail.count >= 0
      ) {
        setVisibleCartCount(detail.count);
      }
    };

    window.addEventListener("kapchi:cart-updated", updateCartCount);
    return () => window.removeEventListener("kapchi:cart-updated", updateCartCount);
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleEscape);

    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", handleEscape);
    };
  }, [menuOpen]);

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-white/60 bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(255,255,255,0.8))] backdrop-blur-xl">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="hidden h-20 items-center justify-between gap-10 md:flex">
            <div className="flex min-w-0 items-center gap-8">
              <Brand />
            </div>

            <div className="flex items-center gap-3">
              <nav aria-label="Primary" className="flex items-center gap-1">
                <CartLink active={pathname === "/cart"} cartCount={visibleCartCount} />
                {NAV_ITEMS.map((item) => (
                  <DesktopNavLink
                    key={item.href}
                    href={item.href}
                    active={pathname === item.href}
                  >
                    {item.label}
                  </DesktopNavLink>
                ))}
              </nav>
              <NavbarAuth />
            </div>
          </div>

          <div className="grid h-20 grid-cols-[auto_1fr_auto] items-center md:hidden">
            <HamburgerButton
              controls={menuId}
              open={menuOpen}
              onClick={() => setMenuOpen((value) => !value)}
            />
            <div className="justify-self-center">
              <Brand />
            </div>
            <div className="h-11 w-11" aria-hidden="true" />
          </div>
        </div>
      </header>

      <MobileMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        menuId={menuId}
        pathname={pathname}
        cartCount={visibleCartCount}
      />
    </>
  );
}
