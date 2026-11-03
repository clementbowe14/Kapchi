import Link from "next/link";
import type { CustomerPolicySnapshot } from "@/lib/policies";
import { CURRENT_POLICY_LINKS } from "@/lib/policies";

export function OrderPolicies({ snapshot }: { snapshot: CustomerPolicySnapshot | null }) {
  if (!snapshot) {
    return (
      <section className="mt-6 border-t border-slate-200 pt-5">
        <h2 className="text-base font-semibold text-slate-950">Current store policies</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">This historical order has no recorded policy snapshot. These links show the current policies and do not imply prior acceptance.</p>
        <PolicyLinks links={CURRENT_POLICY_LINKS} />
      </section>
    );
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-5">
      <h2 className="text-base font-semibold text-slate-950">Policies for this order</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">Bundle {snapshot.bundleVersion}, presented {new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(snapshot.statementSubmittedAt))}.</p>
      <PolicyLinks links={snapshot.documents.map(({ key, path }) => ({ key, path, title: CURRENT_POLICY_LINKS.find((policy) => policy.key === key)?.title ?? key }))} />
    </section>
  );
}

function PolicyLinks({ links }: { links: ReadonlyArray<{ key: string; path: string; title: string }> }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
      {links.map((policy) => (
        <li key={policy.key}>
          <Link className="font-semibold text-[#8f734f] underline decoration-[#b49872]/40 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872]" href={policy.path}>{policy.title}</Link>
        </li>
      ))}
    </ul>
  );
}
