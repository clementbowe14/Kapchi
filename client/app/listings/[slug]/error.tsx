"use client";

import Link from "next/link";

export default function ListingDetailError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 items-center px-4 py-16 sm:px-6">
      <section
        aria-labelledby="listing-detail-error-heading"
        className="w-full border-y border-slate-200 py-12 text-center"
        role="alert"
      >
        <h1
          className="text-2xl font-semibold text-slate-950"
          id="listing-detail-error-heading"
        >
          This graduation stole could not be loaded
        </h1>
        <p className="mt-3 text-slate-600">
          The request did not complete. You can try again or return to the
          catalog.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
          <button
            className="min-h-11 bg-[#b49872] px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8f734f] focus-visible:ring-offset-2"
            onClick={reset}
            type="button"
          >
            Try again
          </button>
          <Link
            className="font-semibold text-[#8f734f] underline decoration-2 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8f734f] focus-visible:ring-offset-4"
            href="/#graduation-stoles"
          >
            Return to graduation stoles
          </Link>
        </div>
      </section>
    </main>
  );
}
