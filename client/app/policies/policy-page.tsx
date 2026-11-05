import Link from "next/link";
import { ACTIVE_POLICY_RELEASE, POLICY_RELEASES } from "@/content/generated-policy-manifest";
import type { PolicyKey } from "@/lib/policies";

export function findPolicy(policyKey: string, version?: string) {
  const release = version
    ? POLICY_RELEASES.find((candidate) => candidate.documents.some((document) => document.key === policyKey && document.version === version))
    : ACTIVE_POLICY_RELEASE;
  const document = release?.documents.find((candidate) => candidate.key === policyKey);
  return release && document ? { document, release } : null;
}

export function PolicyPage({ policyKey, version }: { policyKey: PolicyKey; version?: string }) {
  const result = findPolicy(policyKey, version)!;
  const { document, release } = result;
  const dateLabel = release.publicationStatus === "draft" ? "Proposed effective date" : "Effective date";

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-10 sm:px-8 sm:py-16">
      <article className="rounded-lg border border-white/80 bg-white/90 px-5 py-8 shadow-[0_18px_50px_rgba(15,23,42,0.08)] sm:px-10 sm:py-12">
        <header className="border-b border-slate-200 pb-7">
          {release.publicationStatus === "draft" ? (
            <p className="mb-4 inline-flex border border-amber-300 bg-amber-50 px-3 py-1 text-sm font-semibold text-amber-900" role="status">Draft for owner review - not approved for production publication</p>
          ) : null}
          <h1 className="text-3xl font-semibold text-slate-950 sm:text-4xl">{document.title}</h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">{document.summary}</p>
          <dl className="mt-5 grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
            <div><dt className="font-semibold text-slate-900">Version</dt><dd>{document.version}</dd></div>
            <div><dt className="font-semibold text-slate-900">{dateLabel}</dt><dd>{release.effectiveDate}</dd></div>
          </dl>
        </header>

        <div className="mt-8 space-y-9">
          {document.sections.map((section) => (
            <section className="space-y-3" key={section.heading}>
              <h2 className="text-xl font-semibold text-slate-950">{section.heading}</h2>
              {section.paragraphs.map((paragraph) => <p className="max-w-prose text-base leading-7 text-slate-700" key={paragraph}>{paragraph}</p>)}
            </section>
          ))}
        </div>

        <aside className="mt-10 border-t border-slate-200 pt-7" aria-labelledby="related-policies">
          <h2 className="text-base font-semibold text-slate-950" id="related-policies">Related store policies</h2>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-3 text-sm">
            {release.documents.filter((candidate) => candidate.key !== document.key).map((candidate) => (
              <li key={candidate.key}>
                <Link className="font-semibold text-[#8f734f] underline decoration-[#b49872]/40 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872]" href={version ? candidate.path : `/policies/${candidate.key}`}>{candidate.title}</Link>
              </li>
            ))}
          </ul>
        </aside>

        <p className="mt-8 break-all text-xs leading-5 text-slate-500">Content digest: {document.digest}</p>
      </article>
    </main>
  );
}
