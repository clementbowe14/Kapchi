import {
  BlobAccessError,
  BlobNotFoundError,
  BlobRequestAbortedError,
  BlobServiceNotAvailable,
  BlobServiceRateLimited,
  BlobStoreNotFoundError,
  BlobStoreSuspendedError,
  get
} from "@vercel/blob";
import { PrivateAssetProviderError } from "./errors.js";
import type { PrivateAssetReader } from "./types.js";

export type VercelPrivateAssetReaderOptions = {
  oidcToken?: string;
  storeId?: string;
  token?: string;
};

function providerError(error: unknown, abortSignal: AbortSignal) {
  if (abortSignal.aborted || error instanceof BlobRequestAbortedError) {
    return new PrivateAssetProviderError("aborted", { cause: error });
  }
  if (error instanceof BlobNotFoundError) {
    return new PrivateAssetProviderError("not_found", { cause: error });
  }
  if (error instanceof BlobServiceRateLimited) {
    return new PrivateAssetProviderError("rate_limited", {
      cause: error,
      retryAfterSeconds: 30
    });
  }
  if (
    error instanceof BlobAccessError ||
    error instanceof BlobStoreNotFoundError ||
    error instanceof BlobStoreSuspendedError
  ) {
    return new PrivateAssetProviderError("misconfigured", { cause: error });
  }
  if (error instanceof BlobServiceNotAvailable) {
    return new PrivateAssetProviderError("unavailable", { cause: error });
  }
  return new PrivateAssetProviderError("unavailable", { cause: error });
}

export class VercelPrivateAssetReader implements PrivateAssetReader {
  readonly configured: boolean;

  constructor(private readonly options: VercelPrivateAssetReaderOptions) {
    this.configured = Boolean(
      options.token || (options.oidcToken && options.storeId),
    );
  }

  async open(input: { abortSignal: AbortSignal; storageKey: string }) {
    if (!this.configured) {
      throw new PrivateAssetProviderError("misconfigured");
    }

    try {
      const result = await get(input.storageKey, {
        access: "private",
        abortSignal: input.abortSignal,
        ...(this.options.oidcToken
          ? { oidcToken: this.options.oidcToken, storeId: this.options.storeId }
          : {}),
        ...(this.options.token ? { token: this.options.token } : {}),
        useCache: false
      });

      if (!result) {
        throw new PrivateAssetProviderError("not_found");
      }
      if (result.statusCode !== 200 || !result.stream) {
        throw new PrivateAssetProviderError("unavailable");
      }

      return {
        checksum: result.blob.etag || null,
        contentType: result.blob.contentType,
        pathname: result.blob.pathname,
        size: result.blob.size,
        stream: result.stream
      };
    } catch (error) {
      if (error instanceof PrivateAssetProviderError) throw error;
      throw providerError(error, input.abortSignal);
    }
  }
}
