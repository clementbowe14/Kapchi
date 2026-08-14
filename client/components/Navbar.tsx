"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MobileMenu } from "@/components/MobileMenu";
import { NavbarAuth } from "@/components/NavbarAuth";
import { CartIcon } from "@/components/NavIcons";
import {
  parseCartSummary,
  subscribeToCartInvalidations,
} from "@/lib/cart-state";
import { NAV_ITEMS } from "@/lib/navigation";

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
  cartCount,
}: {
  active?: boolean;
  cartCount: number | null;
}) {
  return (
    <Link
      href="/cart"
      aria-label={
        cartCount !== null && cartCount > 0
          ? `Cart with ${cartCount} ${cartCount === 1 ? "item" : "items"}`
          : "Cart"
      }
      aria-current={active ? "page" : undefined}
      className={`relative inline-flex h-11 items-center gap-2 rounded-full px-4 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2 ${
        active
          ? "bg-[#b49872]/14 text-[#8f734f]"
          : "text-slate-700 hover:bg-white/60 hover:text-slate-950"
      }`}
    >
      <CartIcon className="h-5 w-5" />
      <span>Cart</span>
      {cartCount !== null && cartCount > 0 ? (
        <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-[#b49872] px-1.5 py-0.5 text-[11px] font-semibold text-white">
          {cartCount}
        </span>
      ) : null}
    </Link>
  );
}

export function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [cartCountSnapshot, setCartCountSnapshot] = useState<{
    count: number;
    identity: string;
  } | null>(null);
  const { getToken, isLoaded: authLoaded, isSignedIn, userId } = useAuth();
  const pathname = usePathname();
  const menuId = useId();
  const requestSequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const authIdentity = authLoaded
    ? isSignedIn
      ? `account:${userId ?? "unknown"}`
      : "guest"
    : "loading";
  const visibleCartCount =
    cartCountSnapshot?.identity === authIdentity
      ? cartCountSnapshot.count
      : null;

  const refreshCartCount = useCallback(async () => {
    if (!authLoaded) {
      return;
    }

    const sequence = ++requestSequence.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;

    try {
      const headers: HeadersInit = {};
      if (isSignedIn) {
        const token = await getToken();
        if (!token || controller.signal.aborted || sequence !== requestSequence.current) {
          return;
        }
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch("/api/cart/summary", {
        cache: "no-store",
        credentials: "include",
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        return;
      }

      const summary = parseCartSummary(await response.json());
      if (!controller.signal.aborted && sequence === requestSequence.current) {
        setCartCountSnapshot({
          count: summary.totalQuantity,
          identity: authIdentity,
        });
      }
    } catch {
      // Retain the last confirmed count when the summary cannot be read.
    }
  }, [authIdentity, authLoaded, getToken, isSignedIn]);

  useEffect(() => {
    if (!authLoaded) {
      return;
    }

    const initialRefresh = window.setTimeout(() => {
      void refreshCartCount();
    }, 0);

    return () => {
      window.clearTimeout(initialRefresh);
      requestSequence.current += 1;
      activeRequest.current?.abort();
    };
  }, [authIdentity, authLoaded, refreshCartCount]);

  useEffect(() => {
    if (!authLoaded) {
      return;
    }

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshCartCount();
      }
    };
    const refreshOnPageShow = () => void refreshCartCount();
    const unsubscribe = subscribeToCartInvalidations(() => {
      void refreshCartCount();
    });

    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener("pageshow", refreshOnPageShow);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      unsubscribe();
      window.removeEventListener("focus", refreshWhenVisible);
      window.removeEventListener("pageshow", refreshOnPageShow);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [authLoaded, refreshCartCount]);

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
