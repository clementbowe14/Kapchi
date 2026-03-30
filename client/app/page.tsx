import { AuthControls } from "@/components/AuthControls";

export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16 sm:px-8">
      <section className="w-full max-w-3xl rounded-[2rem] border border-black/8 bg-white/90 p-8 shadow-[0_24px_80px_rgba(15,23,42,0.10)] backdrop-blur sm:p-12">
        <div className="max-w-2xl space-y-6">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[#b49872]">
            Kapchi
          </p>
          <div className="space-y-4">
            <h1 className="text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              A clean Clerk auth flow, wired for the App Router.
            </h1>
            <p className="max-w-xl text-base leading-7 text-slate-600 sm:text-lg">
              The homepage stays intentionally minimal while the navbar and auth
              routes share the same Clerk-backed state and redirect behavior.
            </p>
          </div>
          <AuthControls variant="home" />
        </div>
      </section>
    </main>
  );
}
