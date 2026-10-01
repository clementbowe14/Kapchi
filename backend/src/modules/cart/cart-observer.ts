import type { FastifyBaseLogger } from "fastify";
import { safeErrorDetails } from "../../observability/safe-error.js";

export type CartActorType = "authenticated" | "guest";
export type CartOperation =
  | "add"
  | "claim"
  | "read"
  | "remove"
  | "summary"
  | "update";
export type CartSuccessEvent =
  | "cart.claim.completed"
  | "cart.item.added"
  | "cart.item.removed"
  | "cart.item.updated"
  | "cart.read.completed";

export type CartEventFields = {
  actorType: CartActorType;
  cartId?: string;
  cartItemId?: string;
  customizationPackageId?: string;
  estimateOutcome?: "accepted" | "preserved" | "replayed";
  lineItemCount?: number;
  listingId?: string;
  operation: CartOperation;
  priorityCode?: string;
  revision?: number;
  ruleId?: string;
  ruleRevision?: number;
  subtotalCents?: number;
  totalQuantity?: number;
};

export type CartFailureFields = Pick<
  CartEventFields,
  "actorType" | "cartId" | "cartItemId" | "operation"
> & {
  errorCode?: string;
  statusCode: number;
};

export type CartClock = {
  now(): number;
};

type SafeLogger = Pick<FastifyBaseLogger, "error" | "info" | "warn">;

const SAFE_ERROR_CODE = /^[A-Z0-9_.-]{1,64}$/i;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_PRIORITY_CODE = /^[a-z][a-z0-9_]{0,31}$/;
const systemClock: CartClock = { now: () => performance.now() };

function durationSince(clock: CartClock, startedAt: number) {
  return Math.max(0, Math.round((clock.now() - startedAt) * 1000) / 1000);
}

function boundedIdentifier(value: unknown) {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value)
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function observableCartFields(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const result = value as Record<string, unknown>;
  const diagnostics =
    result.productionEstimateDiagnostics &&
    typeof result.productionEstimateDiagnostics === "object" &&
    !Array.isArray(result.productionEstimateDiagnostics)
      ? result.productionEstimateDiagnostics as Record<string, unknown>
      : result;
  const estimateOutcome = ["accepted", "preserved", "replayed"].includes(
    String(diagnostics.outcome ?? diagnostics.estimateOutcome),
  )
    ? String(diagnostics.outcome ?? diagnostics.estimateOutcome)
    : undefined;
  return {
    ...(boundedIdentifier(result.cartId)
      ? { cartId: boundedIdentifier(result.cartId) }
      : {}),
    ...(boundedIdentifier(result.cartItemId)
      ? { cartItemId: boundedIdentifier(result.cartItemId) }
      : {}),
    ...(boundedIdentifier(diagnostics.customizationPackageId)
      ? { customizationPackageId: boundedIdentifier(diagnostics.customizationPackageId) }
      : {}),
    ...(estimateOutcome ? { estimateOutcome } : {}),
    ...(boundedIdentifier(diagnostics.listingId)
      ? { listingId: boundedIdentifier(diagnostics.listingId) }
      : {}),
    ...(typeof diagnostics.priorityCode === "string" &&
    SAFE_PRIORITY_CODE.test(diagnostics.priorityCode)
      ? { priorityCode: diagnostics.priorityCode }
      : {}),
    ...(boundedIdentifier(diagnostics.ruleId)
      ? { ruleId: boundedIdentifier(diagnostics.ruleId) }
      : {}),
    ...(nonNegativeInteger(diagnostics.ruleRevision) !== undefined
      ? { ruleRevision: nonNegativeInteger(diagnostics.ruleRevision) }
      : {}),
    ...(nonNegativeInteger(result.revision) !== undefined
      ? { revision: nonNegativeInteger(result.revision) }
      : {}),
    ...(nonNegativeInteger(result.lineItemCount) !== undefined
      ? { lineItemCount: nonNegativeInteger(result.lineItemCount) }
      : {}),
    ...(nonNegativeInteger(result.totalQuantity) !== undefined
      ? { totalQuantity: nonNegativeInteger(result.totalQuantity) }
      : {}),
    ...(nonNegativeInteger(result.subtotalCents) !== undefined
      ? { subtotalCents: nonNegativeInteger(result.subtotalCents) }
      : {})
  };
}

export interface CartObserver {
  completed(
    event: CartSuccessEvent,
    fields: CartEventFields,
    startedAt: number,
  ): void;
  failed(
    fields: CartFailureFields,
    error: unknown,
    startedAt: number,
  ): void;
  start(): number;
}

export function createCartObserver(
  logger: SafeLogger,
  clock: CartClock = systemClock,
): CartObserver {
  return {
    completed(event, fields, startedAt) {
      try {
        logger.info(
          {
            event,
            actorType: fields.actorType,
            operation: fields.operation,
            ...observableCartFields(fields),
            durationMs: durationSince(clock, startedAt)
          },
          "Cart lifecycle event",
        );
      } catch {
        // Diagnostics must never change cart behavior.
      }
    },
    failed(fields, error, startedAt) {
      try {
        const details = safeErrorDetails(error);
        const identifiers = observableCartFields(fields);
        const errorCode =
          fields.errorCode && SAFE_ERROR_CODE.test(fields.errorCode)
            ? fields.errorCode
            : details.errorCode;
        const logFields = {
          event: "cart.operation.failed",
          actorType: fields.actorType,
          ...(identifiers.cartId ? { cartId: identifiers.cartId } : {}),
          ...(identifiers.cartItemId ? { cartItemId: identifiers.cartItemId } : {}),
          durationMs: durationSince(clock, startedAt),
          ...(errorCode ? { errorCode } : {}),
          errorType: details.errorType,
          operation: fields.operation,
          retryable: fields.statusCode >= 500,
          statusCode: fields.statusCode
        };
        const level = fields.statusCode >= 500 ? "error" : "warn";
        logger[level](logFields, "Cart lifecycle event");
      } catch {
        // Diagnostics must never change cart behavior.
      }
    },
    start() {
      return clock.now();
    }
  };
}
