export type AssetDisposition = "attachment" | "inline";

export type AssetEligibility =
  | "binding_invalid"
  | "deleted"
  | "eligible"
  | "not_ready"
  | "not_selected"
  | "order_not_purchased"
  | "provider_unconfigured"
  | "provider_unsupported"
  | "quarantined"
  | "record_missing"
  | "reference_mismatch";

export type PrivateAssetActor = {
  authSubject: string;
  userId: string;
};

export type PrivateAssetLookup = {
  asset: {
    byteSize: number;
    checksum: string | null;
    contentType: string;
    context: string;
    expectedPathname: string | null;
    id: string;
    originalFilename: string | null;
    provider: string;
    status: string;
    storageKey: string | null;
    visibility: string;
  } | null;
  canonicalAssetId: string | null;
  orderId: string;
  orderItemId: string;
  paidAt: string | null;
  snapshotAssetId: string | null;
};

export type PrivateAssetDescriptor = {
  asset: {
    byteSize: number;
    contentType: string;
    filename: string;
    id: string;
    recordStatus: string;
    visibility: string;
  } | null;
  orderId: string;
  orderItemId: string;
  retrieval: {
    downloadUrl: string | null;
    eligibility: AssetEligibility;
    previewUrl: string | null;
    reasonCode: string | null;
  };
};

export type PrivateAssetProviderObject = {
  checksum: string | null;
  contentType: string;
  pathname: string;
  size: number;
  stream: ReadableStream<Uint8Array>;
};

export type PrivateAssetReader = {
  configured: boolean;
  open(input: {
    abortSignal: AbortSignal;
    storageKey: string;
  }): Promise<PrivateAssetProviderObject>;
};

export type PreparedPrivateAsset = {
  assetId: string;
  byteSize: number;
  contentType: string;
  filename: string;
  provider: string;
  retryCount: number;
  stream: ReadableStream<Uint8Array>;
  bytesRead(): number;
};
