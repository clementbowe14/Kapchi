import type { ReactNode } from "react";

type PageShellProps = {
  eyebrow: string;
  children?: ReactNode;
  description: string;
  title: string;
};

export function PageShell({
  children,
  description,
  eyebrow,
  title,
}: PageShellProps) {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16 sm:px-8">
      <section className="w-full max-w-4xl rounded-[2rem] border border-black/8 bg-white/90 p-8 shadow-[0_24px_80px_rgba(15,23,42,0.10)] backdrop-blur sm:p-12">
        <div className="max-w-3xl space-y-6">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[#b49872]">
            {eyebrow}
          </p>
          <div className="space-y-4">
            <h1 className="text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              {title}
            </h1>
            <p className="max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
              {description}
            </p>
          </div>
          {children}
        </div>
      </section>
    </main>
  );
}
