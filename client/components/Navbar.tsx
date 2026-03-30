import Link from "next/link";
import { AuthControls } from "@/components/AuthControls";

export function Navbar() {
  return (
    <header className="border-b border-black/6 bg-white/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4 sm:px-8">
        <Link
          href="/"
          className="text-lg font-semibold tracking-tight text-[#b49872]"
        >
          Kapchi
        </Link>
        <AuthControls variant="navbar" />
      </div>
    </header>
  );
}
