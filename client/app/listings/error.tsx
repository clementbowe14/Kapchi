"use client";

export default function ListingsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 items-center px-4 py-16 sm:px-6">
      <section aria-labelledby="listing-error-heading" className="w-full border-y border-slate-200 py-12 text-center" role="alert">
        <h1 className="text-2xl font-semibold text-slate-950" id="listing-error-heading">The graduation stole catalog is unavailable</h1>
        <p className="mt-3 text-slate-600">The request did not complete. Please try again.</p>
        <button className="mt-6 min-h-11 bg-[#b49872] px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8f734f] focus-visible:ring-offset-2" onClick={reset} type="button">Try again</button>
      </section>
    </main>
  );
}
