export default function ListingsLoading() {
  return (
    <main aria-busy="true" aria-live="polite" className="mx-auto w-full max-w-7xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
      <p className="text-sm font-medium text-slate-600">Loading graduation stoles</p>
      <div aria-hidden="true" className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((item) => <div className="h-[31rem] animate-pulse bg-slate-100" key={item} />)}
      </div>
    </main>
  );
}
