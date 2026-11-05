import Link from "next/link";
import { CURRENT_POLICY_LINKS } from "@/lib/policies";

export function StorePolicyFooter() {
  return (
    <footer className="border-t border-slate-200/80 bg-white/75" data-testid="store-policy-footer">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-5 py-7 sm:px-8 lg:flex-row lg:items-center lg:justify-between">
        <p className="text-sm font-semibold text-slate-700">Kapchi store policies</p>
        <nav aria-label="Store policies">
          <ul className="flex flex-wrap gap-x-5 gap-y-3 text-sm">
            {CURRENT_POLICY_LINKS.map((policy) => (
              <li key={policy.key}>
                <Link className="text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-[#8f734f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2" href={policy.path}>
                  {policy.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
