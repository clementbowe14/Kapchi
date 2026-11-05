import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ACTIVE_POLICY_RELEASE } from "@/content/generated-policy-manifest";
import { POLICY_KEYS, type PolicyKey } from "@/lib/policies";
import { findPolicy, PolicyPage } from "../policy-page";

type PageProps = { params: Promise<{ policyKey: string }> };

export function generateStaticParams() {
  return POLICY_KEYS.map((policyKey) => ({ policyKey }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { policyKey } = await params;
  const result = findPolicy(policyKey);
  if (!result) return {};
  return { title: `${result.document.title} | Kapchi`, description: result.document.summary };
}

export default async function CurrentPolicyPage({ params }: PageProps) {
  const { policyKey } = await params;
  if (!POLICY_KEYS.includes(policyKey as PolicyKey) || !findPolicy(policyKey)) notFound();
  return <PolicyPage policyKey={policyKey as PolicyKey} version={undefined} key={ACTIVE_POLICY_RELEASE.bundleVersion} />;
}
