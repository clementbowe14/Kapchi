import type { ReactNode } from "react";

type AuthShellProps = {
  children: ReactNode;
};

export function AuthShell({ children }: AuthShellProps) {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16 sm:px-8">
      <section className="auth-shell-enter flex w-full max-w-3xl items-center justify-center rounded-[2rem] border border-white/55 bg-white/20 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_28px_90px_rgba(15,23,42,0.12)] backdrop-blur-2xl sm:p-8">
        {children}
      </section>
    </main>
  );
}
