import { createHash } from "node:crypto";

export const PRODUCTION_ESTIMATE_QUALIFIER =
  "This is an estimate, not a guaranteed delivery date. Shipping time is additional; weekends, holidays, destination, and carrier delays may affect timing.";

export type ProductionEstimateSnapshot = {
  maximumBusinessDays: number;
  minimumBusinessDays: number;
  priorityCode: string;
  priorityLabel: string;
  quotedAt: string;
  ruleId: string;
  ruleRevision: number;
  schemaVersion: 1;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown, minimum: number) {
  return Number.isSafeInteger(value) && Number(value) >= minimum
    ? Number(value)
    : null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseProductionEstimateSnapshot(
  value: unknown,
): ProductionEstimateSnapshot | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;

  const minimumBusinessDays = integer(value.minimumBusinessDays, 0);
  const maximumBusinessDays = integer(value.maximumBusinessDays, 0);
  const ruleRevision = integer(value.ruleRevision, 1);
  const priorityCode =
    typeof value.priorityCode === "string" &&
    /^[a-z][a-z0-9_]{0,31}$/.test(value.priorityCode)
      ? value.priorityCode
      : null;
  const priorityLabel =
    typeof value.priorityLabel === "string" &&
    value.priorityLabel.length <= 80 &&
    value.priorityLabel === value.priorityLabel.trim() &&
    value.priorityLabel.length > 0
      ? value.priorityLabel
      : null;
  const ruleId =
    typeof value.ruleId === "string" && UUID_PATTERN.test(value.ruleId)
      ? value.ruleId
      : null;
  const quotedAt =
    typeof value.quotedAt === "string" &&
    !Number.isNaN(Date.parse(value.quotedAt)) &&
    new Date(value.quotedAt).toISOString() === value.quotedAt
      ? value.quotedAt
      : null;

  if (
    minimumBusinessDays === null ||
    maximumBusinessDays === null ||
    maximumBusinessDays < minimumBusinessDays ||
    ruleRevision === null ||
    !priorityCode ||
    !priorityLabel ||
    !ruleId ||
    !quotedAt
  ) {
    return null;
  }

  return {
    maximumBusinessDays,
    minimumBusinessDays,
    priorityCode,
    priorityLabel,
    quotedAt,
    ruleId,
    ruleRevision,
    schemaVersion: 1
  };
}

export function productionEstimateFingerprint(
  snapshot: ProductionEstimateSnapshot,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        maximumBusinessDays: snapshot.maximumBusinessDays,
        minimumBusinessDays: snapshot.minimumBusinessDays,
        priorityCode: snapshot.priorityCode,
        ruleId: snapshot.ruleId,
        ruleRevision: snapshot.ruleRevision,
        schemaVersion: snapshot.schemaVersion
      }),
    )
    .digest("hex");
}

export function productionEstimateSummary(
  snapshot: ProductionEstimateSnapshot,
) {
  return {
    maximumBusinessDays: snapshot.maximumBusinessDays,
    minimumBusinessDays: snapshot.minimumBusinessDays,
    priorityCode: snapshot.priorityCode,
    priorityLabel: snapshot.priorityLabel,
    qualifier: PRODUCTION_ESTIMATE_QUALIFIER
  };
}
