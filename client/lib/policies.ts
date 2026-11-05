import { ACTIVE_POLICY_RELEASE } from "@/content/generated-policy-manifest";
import { buildApiUrl } from "./api";

export const POLICY_KEYS = ["shipping", "returns", "privacy", "terms"] as const;
export type PolicyKey = (typeof POLICY_KEYS)[number];
export type PolicyRole = "agreement" | "acknowledgment" | "notice";

export type PolicyDocumentMetadata = {
  key: PolicyKey;
  title: string;
  role: PolicyRole;
  version: string;
  digest: string;
  path: string;
};

export type CheckoutPolicyBundle = {
  schemaVersion: 1;
  bundleVersion: string;
  effectiveDate: string;
  checkoutStatement: { version: string; digest: string };
  documents: PolicyDocumentMetadata[];
};

export type CustomerPolicySnapshot = Omit<CheckoutPolicyBundle, "documents"> & {
  statementSubmittedAt: string;
  documents: Array<Omit<PolicyDocumentMetadata, "title">>;
};

const POLICY_ROLES: Record<PolicyKey, PolicyRole> = {
  shipping: "notice",
  returns: "acknowledgment",
  privacy: "notice",
  terms: "agreement",
};
const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}\.[1-9]\d*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPolicyKey(value: unknown): value is PolicyKey {
  return POLICY_KEYS.includes(value as PolicyKey);
}

function parseDocument(value: unknown): PolicyDocumentMetadata {
  if (!isRecord(value) || !isPolicyKey(value.key) || !nonEmptyString(value.title) || value.role !== POLICY_ROLES[value.key] || !nonEmptyString(value.version) || !VERSION_PATTERN.test(value.version) || !/^[a-f0-9]{64}$/.test(String(value.digest)) || value.path !== `/policies/${value.key}/${value.version}`) {
    throw new Error("Invalid policy document metadata.");
  }
  return {
    key: value.key,
    title: value.title,
    role: POLICY_ROLES[value.key],
    version: value.version,
    digest: String(value.digest),
    path: value.path,
  };
}

export function parseCheckoutPolicyBundle(value: unknown): CheckoutPolicyBundle {
  if (!isRecord(value) || value.schemaVersion !== 1 || !nonEmptyString(value.bundleVersion) || !VERSION_PATTERN.test(value.bundleVersion) || !nonEmptyString(value.effectiveDate) || !DATE_PATTERN.test(value.effectiveDate) || !isRecord(value.checkoutStatement) || !nonEmptyString(value.checkoutStatement.version) || !VERSION_PATTERN.test(value.checkoutStatement.version) || !/^[a-f0-9]{64}$/.test(String(value.checkoutStatement.digest)) || !Array.isArray(value.documents)) {
    throw new Error("Invalid checkout policy bundle.");
  }
  const documents = value.documents.map(parseDocument);
  if (documents.length !== POLICY_KEYS.length || documents.some((document, index) => document.key !== POLICY_KEYS[index])) {
    throw new Error("Invalid checkout policy document order.");
  }
  return {
    schemaVersion: 1,
    bundleVersion: value.bundleVersion,
    effectiveDate: value.effectiveDate,
    checkoutStatement: {
      version: value.checkoutStatement.version,
      digest: String(value.checkoutStatement.digest),
    },
    documents,
  };
}

export function parseCustomerPolicySnapshot(value: unknown): CustomerPolicySnapshot | null {
  if (value === null || typeof value === "undefined") return null;
  if (!isRecord(value) || !nonEmptyString(value.statementSubmittedAt) || Number.isNaN(Date.parse(value.statementSubmittedAt))) {
    throw new Error("Invalid customer policy snapshot.");
  }
  if (value.schemaVersion !== 1 || !nonEmptyString(value.bundleVersion) || !VERSION_PATTERN.test(value.bundleVersion) || !nonEmptyString(value.effectiveDate) || !DATE_PATTERN.test(value.effectiveDate) || !isRecord(value.checkoutStatement) || !nonEmptyString(value.checkoutStatement.version) || !VERSION_PATTERN.test(value.checkoutStatement.version) || !/^[a-f0-9]{64}$/.test(String(value.checkoutStatement.digest)) || !Array.isArray(value.documents)) {
    throw new Error("Invalid customer policy snapshot.");
  }
  const documents = value.documents.map((document) => {
    if (!isRecord(document) || !isPolicyKey(document.key) || document.role !== POLICY_ROLES[document.key] || !nonEmptyString(document.version) || !VERSION_PATTERN.test(document.version) || !/^[a-f0-9]{64}$/.test(String(document.digest)) || document.path !== `/policies/${document.key}/${document.version}`) {
      throw new Error("Invalid customer policy snapshot document.");
    }
    return { key: document.key, role: POLICY_ROLES[document.key], version: document.version, digest: String(document.digest), path: document.path };
  });
  if (documents.length !== POLICY_KEYS.length || documents.some((document, index) => document.key !== POLICY_KEYS[index])) {
    throw new Error("Invalid customer policy snapshot document order.");
  }
  return {
    schemaVersion: 1,
    bundleVersion: value.bundleVersion,
    effectiveDate: value.effectiveDate,
    checkoutStatement: { version: value.checkoutStatement.version, digest: String(value.checkoutStatement.digest) },
    documents,
    statementSubmittedAt: value.statementSubmittedAt,
  };
}

export async function fetchCheckoutPolicyBundle({ bypassCache = false }: { bypassCache?: boolean } = {}) {
  const query = bypassCache ? `?refresh=${Date.now()}` : "";
  const response = await fetch(buildApiUrl(`/payments/checkout-policy${query}`), {
    cache: bypassCache ? "no-store" : "default",
    credentials: "include",
    headers: bypassCache ? { "Cache-Control": "no-cache" } : undefined,
  });
  if (!response.ok) throw new Error("Checkout policies are unavailable.");
  return parseCheckoutPolicyBundle(await response.json());
}

export const CURRENT_POLICY_LINKS = ACTIVE_POLICY_RELEASE.documents.map((document) => ({
  key: document.key,
  path: `/policies/${document.key}`,
  title: document.title,
}));
