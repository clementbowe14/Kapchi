export type AdminAssetErrorOptions = {
  assetId?: string | null;
  retryAfterSeconds?: number;
  retryable?: boolean;
};

export class AdminAssetError extends Error {
  readonly assetId: string | null;
  readonly retryAfterSeconds: number | null;
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    options: AdminAssetErrorOptions = {},
  ) {
    super(message);
    this.name = "AdminAssetError";
    this.assetId = options.assetId ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export type ProviderFailureKind =
  | "aborted"
  | "misconfigured"
  | "not_found"
  | "rate_limited"
  | "unavailable";

export class PrivateAssetProviderError extends Error {
  constructor(
    readonly kind: ProviderFailureKind,
    options: { cause?: unknown; retryAfterSeconds?: number } = {},
  ) {
    super(`Private asset provider ${kind.replace(/_/g, " ")}.`, {
      cause: options.cause
    });
    this.name = "PrivateAssetProviderError";
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }

  readonly retryAfterSeconds: number | null;
}
