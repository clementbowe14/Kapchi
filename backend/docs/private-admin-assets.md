# Private admin customization assets

Kapchi exposes purchased customization artwork only through authenticated
Fastify routes. The browser never receives a Vercel Blob URL, storage key, or
provider credential.

## Routes

Both routes require the exact store-admin role through the `assets:read`
capability and an active local user mapped to the verified Clerk subject.

```text
GET /admin/orders/:orderId/items/:orderItemId/customization-asset
GET /admin/orders/:orderId/items/:orderItemId/customization-asset/content?disposition=inline|attachment
```

The metadata route is database-only. Its `eligible` status means that the
order, item, asset record, provider configuration, and canonical pathname pass
local checks. It does not assert that the provider object currently exists.

The content route derives the asset from the order item. It does not accept an
asset ID or URL. Retrieval requires `orders.paid_at` and remains available for
orders later cancelled or refunded. Unpaid and abandoned checkouts are denied.

## Historical binding

`order_items.customization_asset_id` is the canonical reference and uses
`ON DELETE RESTRICT`. The snapshot asset ID is checked for disagreement but is
never used as retrieval authority when the FK is absent. Listing and fabric
changes therefore cannot redirect a purchased order to different artwork.

The provider pathname must equal `assets.metadata.expectedPathname` and match:

```text
kapchi/customization_image/{assetId}/{safe-ascii-filename}
```

The adapter ignores `assets.url` and opens only this validated storage key.

## Provider configuration

The backend uses `@vercel/blob` with private access. Configure either:

- Vercel workload identity through `VERCEL_OIDC_TOKEN` and `BLOB_STORE_ID`; or
- the server-only `BLOB_READ_WRITE_TOKEN` used by the existing upload runtime.

These values must remain encrypted runtime secrets. They are not database
metadata and must never be sent to an administrator or written to logs.

Optional controls:

```bash
ASSET_PRIVATE_OPEN_TIMEOUT_MS=5000
ASSET_PRIVATE_IDLE_TIMEOUT_MS=15000
ASSET_PRIVATE_TOTAL_TIMEOUT_MS=60000
ASSET_PRIVATE_CROSS_ORIGIN_POLICY=same-site
```

The application starts without credentials so database-only workflows remain
available. `/ready` reports `privateAssetProvider: unconfigured`, and content
retrieval returns `ASSET_PROVIDER_MISCONFIGURED` without pretending the failure
is transient.

## Content safety

Only JPEG, PNG, and WebP are delivered. Before response headers, the service
checks provider pathname, MIME type, size, optional ETag, and a bounded file
signature. HTML, SVG, script prefixes, malformed signatures, size mismatches,
overflow, and truncation fail closed. Responses are streamed with byte limits,
timeouts, cancellation, `no-store`, `nosniff`, a restrictive inline CSP, and a
sanitized RFC 5987 filename.

Transient provider open failures receive one pre-header retry. No retry occurs
after client bytes begin. Post-header stream failures terminate the response;
they cannot be converted into a JSON error.

## Audit and operations

Every authorized content attempt writes one row to
`admin_private_asset_access_events`. Successful delivery records `opened`
before response headers; if that insert fails, no content is sent. Completion,
client abort, and post-header failure update the row on a best-effort basis.

Lifecycle logs include request, actor, order, item, asset, provider category,
retry count, duration, and bytes. They exclude filenames, storage keys, URLs,
credentials, checksums, raw provider errors, and customer-entered customization
text.

Common safe codes:

| Code | Meaning |
| --- | --- |
| `ORDER_NOT_PURCHASED` | The checkout never became a purchased order. |
| `ASSET_REFERENCE_MISMATCH` | FK and historical snapshot disagree. |
| `ASSET_BINDING_INVALID` | The private provider pathname is not canonical. |
| `ASSET_QUARANTINED` | The object is intentionally blocked. |
| `ASSET_CONTENT_MISSING` | The provider no longer has the object. |
| `ASSET_CONTENT_INVALID` | Provider bytes or metadata failed validation. |
| `ASSET_PROVIDER_MISCONFIGURED` | Credentials or provider setup need operator action. |
| `ASSET_PROVIDER_UNAVAILABLE` | A retryable provider failure exhausted its retry. |
