import { setTimeout as delay } from "node:timers/promises";
import { hasValidCustomizationAssetBinding } from "../assets/pathname.js";
import { inspectPrivateImage, safeAssetFilename } from "./content.js";
import { AdminAssetError, PrivateAssetProviderError } from "./errors.js";
import type { AdminAssetRepositoryPort } from "./repository.js";
import type {
  AssetEligibility,
  PreparedPrivateAsset,
  PrivateAssetDescriptor,
  PrivateAssetLookup,
  PrivateAssetReader
} from "./types.js";

type ServiceOptions = {
  idleTimeoutMs: number;
  maxBytes: number;
  openTimeoutMs: number;
  readers: Readonly<Record<string, PrivateAssetReader>>;
};

const REASONS: Record<Exclude<AssetEligibility, "eligible">, string> = {
  binding_invalid: "ASSET_BINDING_INVALID",
  deleted: "ASSET_DELETED",
  not_ready: "ASSET_NOT_READY",
  not_selected: "ASSET_NOT_SELECTED",
  order_not_purchased: "ORDER_NOT_PURCHASED",
  provider_unconfigured: "ASSET_PROVIDER_MISCONFIGURED",
  provider_unsupported: "ASSET_PROVIDER_UNSUPPORTED",
  quarantined: "ASSET_QUARANTINED",
  record_missing: "ASSET_RECORD_MISSING",
  reference_mismatch: "ASSET_REFERENCE_MISMATCH"
};

function eligibility(
  value: PrivateAssetLookup,
  readers: ServiceOptions["readers"],
): AssetEligibility {
  if (value.paidAt === null) return "order_not_purchased";
  if (
    value.canonicalAssetId &&
    value.snapshotAssetId &&
    value.canonicalAssetId !== value.snapshotAssetId
  ) {
    return "reference_mismatch";
  }
  if (!value.canonicalAssetId) {
    return value.snapshotAssetId ? "record_missing" : "not_selected";
  }
  if (!value.asset || value.asset.id !== value.canonicalAssetId) return "record_missing";
  if (value.asset.status === "quarantined") return "quarantined";
  if (value.asset.status === "discarded") return "deleted";
  if (value.asset.status !== "attached") return "not_ready";
  if (
    value.asset.context !== "customization_image" ||
    value.asset.visibility !== "private" ||
    !hasValidCustomizationAssetBinding({
      assetId: value.asset.id,
      expectedPathname: value.asset.expectedPathname,
      storageKey: value.asset.storageKey
    })
  ) {
    return "binding_invalid";
  }
  const reader = readers[value.asset.provider];
  if (!reader) return "provider_unsupported";
  if (!reader.configured) return "provider_unconfigured";
  return "eligible";
}

function eligibilityError(
  state: Exclude<AssetEligibility, "eligible">,
  assetId: string | null,
) {
  const code = REASONS[state];
  const contracts: Record<string, { message: string; status: number }> = {
    ASSET_BINDING_INVALID: {
      message: "The customization asset binding is invalid.",
      status: 409
    },
    ASSET_DELETED: {
      message: "The customization asset is no longer available.",
      status: 410
    },
    ASSET_NOT_READY: {
      message: "The customization asset is not ready.",
      status: 409
    },
    ASSET_NOT_SELECTED: {
      message: "This order item has no customization asset.",
      status: 404
    },
    ASSET_PROVIDER_MISCONFIGURED: {
      message: "Private asset delivery is not configured.",
      status: 503
    },
    ASSET_PROVIDER_UNSUPPORTED: {
      message: "The customization asset provider is unavailable.",
      status: 503
    },
    ASSET_QUARANTINED: {
      message: "The customization asset is quarantined.",
      status: 423
    },
    ASSET_RECORD_MISSING: {
      message: "The customization asset record is missing.",
      status: 410
    },
    ASSET_REFERENCE_MISMATCH: {
      message: "The customization asset references do not match.",
      status: 409
    },
    ORDER_NOT_PURCHASED: {
      message: "Private customization assets require a purchased order.",
      status: 409
    }
  };
  const contract = contracts[code];
  return new AdminAssetError(code, contract.message, contract.status, { assetId });
}

function providerError(error: PrivateAssetProviderError, assetId: string) {
  if (error.kind === "not_found") {
    return new AdminAssetError(
      "ASSET_CONTENT_MISSING",
      "The customization asset content is missing.",
      410,
      { assetId },
    );
  }
  if (error.kind === "misconfigured") {
    return new AdminAssetError(
      "ASSET_PROVIDER_MISCONFIGURED",
      "Private asset delivery is not configured.",
      503,
      { assetId },
    );
  }
  return new AdminAssetError(
    "ASSET_PROVIDER_UNAVAILABLE",
    "Private asset delivery is temporarily unavailable.",
    503,
    {
      assetId,
      retryAfterSeconds: error.retryAfterSeconds ?? 30,
      retryable: error.kind !== "aborted"
    },
  );
}

function abortAfter(signal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("private asset provider timeout"), timeoutMs);
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    stop() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  };
}

export class AdminAssetService {
  constructor(
    private readonly repository: AdminAssetRepositoryPort,
    private readonly options: ServiceOptions,
  ) {}

  async metadata(orderId: string, orderItemId: string): Promise<PrivateAssetDescriptor> {
    const value = await this.repository.lookup(orderId, orderItemId);
    const state = eligibility(value, this.options.readers);
    const reasonCode = state === "eligible" ? null : REASONS[state];
    const route = `/admin/orders/${orderId}/items/${orderItemId}/customization-asset/content`;

    return {
      asset: value.asset
        ? {
            byteSize: value.asset.byteSize,
            contentType: value.asset.contentType,
            filename: safeAssetFilename(
              value.asset.originalFilename,
              value.asset.contentType,
            ),
            id: value.asset.id,
            recordStatus: value.asset.status,
            visibility: value.asset.visibility
          }
        : null,
      orderId,
      orderItemId,
      retrieval: {
        downloadUrl: state === "eligible" ? `${route}?disposition=attachment` : null,
        eligibility: state,
        previewUrl: state === "eligible" ? `${route}?disposition=inline` : null,
        reasonCode
      }
    };
  }

  async prepare(
    orderId: string,
    orderItemId: string,
    abortSignal: AbortSignal,
  ): Promise<PreparedPrivateAsset> {
    const value = await this.repository.lookup(orderId, orderItemId);
    const state = eligibility(value, this.options.readers);
    if (state !== "eligible") {
      throw eligibilityError(state, value.canonicalAssetId ?? value.snapshotAssetId);
    }

    const asset = value.asset!;
    const reader = this.options.readers[asset.provider]!;
    let retryCount = 0;

    while (true) {
      const timeout = abortAfter(abortSignal, this.options.openTimeoutMs);
      try {
        const providerObject = await reader.open({
          abortSignal: timeout.signal,
          storageKey: asset.storageKey!
        });
        timeout.stop();

        if (
          providerObject.pathname !== asset.storageKey ||
          providerObject.contentType !== asset.contentType ||
          providerObject.size !== asset.byteSize ||
          (asset.checksum !== null &&
            providerObject.checksum !== null &&
            providerObject.checksum !== asset.checksum)
        ) {
          await providerObject.stream.cancel("private asset metadata mismatch");
          throw new AdminAssetError(
            "ASSET_CONTENT_INVALID",
            "The private asset content does not match its stored metadata.",
            502,
            { assetId: asset.id },
          );
        }

        const inspected = await inspectPrivateImage({
          abortSignal,
          contentType: asset.contentType,
          expectedBytes: asset.byteSize,
          firstByteTimeoutMs: this.options.openTimeoutMs,
          idleTimeoutMs: this.options.idleTimeoutMs,
          maxBytes: this.options.maxBytes,
          stream: providerObject.stream
        });

        const current = await this.repository.lookup(orderId, orderItemId);
        const currentState = eligibility(current, this.options.readers);
        if (
          currentState !== "eligible" ||
          current.canonicalAssetId !== asset.id ||
          current.asset?.storageKey !== asset.storageKey
        ) {
          await inspected.stream.cancel("private asset binding changed");
          if (currentState !== "eligible") {
            throw eligibilityError(
              currentState,
              current.canonicalAssetId ?? current.snapshotAssetId,
            );
          }
          throw new AdminAssetError(
            "ASSET_REFERENCE_MISMATCH",
            "The customization asset binding changed during retrieval.",
            409,
            { assetId: asset.id },
          );
        }

        return {
          assetId: asset.id,
          byteSize: asset.byteSize,
          bytesRead: inspected.bytesRead,
          contentType: asset.contentType,
          filename: safeAssetFilename(asset.originalFilename, asset.contentType),
          provider: asset.provider,
          retryCount,
          stream: inspected.stream
        };
      } catch (error) {
        const providerOpenTimedOut = timeout.signal.aborted && !abortSignal.aborted;
        timeout.stop();
        if (providerOpenTimedOut && error instanceof PrivateAssetProviderError) {
          error = new PrivateAssetProviderError("unavailable", { cause: error });
        }
        if (
          error instanceof PrivateAssetProviderError &&
          (error.kind === "rate_limited" || error.kind === "unavailable") &&
          retryCount === 0 &&
          !abortSignal.aborted
        ) {
          retryCount += 1;
          await delay(50, undefined, { signal: abortSignal }).catch(() => undefined);
          continue;
        }
        if (error instanceof PrivateAssetProviderError) {
          throw providerError(error, asset.id);
        }
        if (error instanceof AdminAssetError && error.assetId === null) {
          throw new AdminAssetError(error.code, error.message, error.statusCode, {
            assetId: asset.id,
            retryAfterSeconds: error.retryAfterSeconds ?? undefined,
            retryable: error.retryable
          });
        }
        throw error;
      }
    }
  }
}
