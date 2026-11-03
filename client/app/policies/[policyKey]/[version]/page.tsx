import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { POLICY_RELEASES } from "@/content/generated-policy-manifest";
import { POLICY_KEYS, type PolicyKey } from "@/lib/policies";
import { findPolicy, PolicyPage } from "../../policy-page";

type PageProps = { params: Promise<{ policyKey: string; version: string }> };

export function generateStaticParams() {
  return POLICY_RELEASES.flatMap((release) => release.documents.map((document) => ({ policyKey: document.key, version: document.version })));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { policyKey, version } = await params;
  const result = findPolicy(policyKey, version);
  if (!result) return {};
  return { title: `${result.document.title} ${version} | Kapchi`, description: `Archived ${result.document.title}, version ${version}.` };
}

export default async function ArchivedPolicyPage({ params }: PageProps) {
  const { policyKey, version } = await params;
  if (!POLICY_KEYS.includes(policyKey as PolicyKey) || !findPolicy(policyKey, version)) notFound();
  return <PolicyPage policyKey={policyKey as PolicyKey} version={version} />;
}
