"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { NavbarAuth } from "@/components/NavbarAuth";
import { CartIcon } from "@/components/NavIcons";
import { NAV_ITEMS } from "@/lib/navigation";

type MobileMenuProps = {
  cartCount?: number;
  menuId: string;
  onClose: () => void;
  open: boolean;
  pathname: string;
};

function MobileNavLink({
  active,
  children,
  href,
  onClose,
}: {
  active?: boolean;
  children: ReactNode;
  href: string;
  onClose: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClose}
      aria-current={active ? "page" : undefined}
      className={`flex items-center justify-between rounded-2xl px-4 py-3 text-base font-medium transition ${
        active
          ? "bg-[#b49872]/14 text-[#8f734f]"
          : "text-slate-700 hover:bg-white/70 hover:text-slate-950"
      }`}
    >
      {children}
    </Link>
  );
}

export function MobileMenu({
  cartCount = 0,
  menuId,
  onClose,
  open,
  pathname,
}: MobileMenuProps) {
  return (
    <div
      className={`fixed inset-0 z-40 md:hidden ${
        open ? "pointer-events-auto" : "pointer-events-none"
      }`}
    >
      <button
        type="button"
        aria-label="Close navigation menu"
        onClick={onClose}
        className={`absolute inset-0 bg-slate-950/30 transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        id={menuId}
        role="dialog"
        aria-modal="true"
        aria-label="Mobile navigation"
        className={`absolute left-0 top-0 flex h-full w-[min(88vw,24rem)] flex-col border-r border-white/60 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(245,247,251,0.92))] p-5 shadow-[0_24px_70px_rgba(15,23,42,0.18)] backdrop-blur-xl transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-6 space-y-2 border-b border-slate-200/70 pb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[#8f734f]">
            Kapchi
          </p>
          <p className="max-w-[16rem] text-sm leading-6 text-slate-600">
            Shop handcrafted pieces and manage your orders from one place.
          </p>
        </div>

        <nav aria-label="Mobile primary" className="space-y-2">
          <MobileNavLink href="/cart" onClose={onClose} active={pathname === "/cart"}>
            <span className="flex items-center gap-3">
              <CartIcon className="h-5 w-5" />
              Cart
            </span>
            {cartCount > 0 ? (
              <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-[#b49872] px-2 py-1 text-xs font-semibold text-white">
                {cartCount}
              </span>
            ) : null}
          </MobileNavLink>

          {NAV_ITEMS.map((item) => (
            <MobileNavLink
              key={item.href}
              href={item.href}
              onClose={onClose}
              active={pathname === item.href}
            >
              {item.label}
            </MobileNavLink>
          ))}
        </nav>

        <div className="mt-auto pt-6">
          <NavbarAuth mobile onNavigate={onClose} />
        </div>
      </div>
    </div>
  );
}
