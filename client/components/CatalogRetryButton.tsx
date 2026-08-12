"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function CatalogRetryButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <button
      className="mt-5 min-h-11 font-semibold text-[#8f734f] underline decoration-2 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8f734f] focus-visible:ring-offset-4 disabled:cursor-wait disabled:opacity-60"
      disabled={isPending}
      onClick={() => startTransition(() => router.refresh())}
      type="button"
    >
      {isPending ? "Trying again" : "Try again"}
    </button>
  );
}
