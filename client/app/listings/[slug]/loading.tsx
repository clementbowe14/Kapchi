export default function ListingDetailLoading() {
  return (
    <main aria-busy="true" aria-live="polite" className="mx-auto grid w-full max-w-7xl flex-1 gap-10 px-4 py-8 sm:px-6 lg:grid-cols-2 lg:px-8">
      <p className="sr-only">Loading graduation stole details</p>
      <div aria-hidden="true" className="aspect-[4/5] animate-pulse bg-slate-100" />
      <div aria-hidden="true" className="space-y-5"><div className="h-10 w-3/4 animate-pulse bg-slate-100" /><div className="h-24 animate-pulse bg-slate-100" /><div className="h-48 animate-pulse bg-slate-100" /></div>
    </main>
  );
}
