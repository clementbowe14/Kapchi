# Guest Browser Attribution

This is optional first-party reporting, not authentication or account linking.
An eligible guest's browser can reuse a signed key across cart rotations. Only
the key's SHA-256 digest is stored on the order. Neither the key nor digest is
returned in JSON, sent to Stripe, or used for cart, order, or artwork access.
There is no contact matching, historical backfill, or cross-device recognition.

## Rollout

1. Apply and verify the exact release's database migration before promoting the
   new backend, including when capture is off. The reporting query and order
   insert refer to the new column. The migration adds a nullable column and a
   partial index; plan for its table/index work in your migration window.
2. Promote with `GUEST_ANALYTICS_COOKIE_SECRET` unset. Verify readiness and
   checkout. A previous build can fail readiness on the new migration manifest;
   treat it as readiness-incompatible unless rehearsed. Follow the
   [production rollback runbook](../../docs/runbooks/production-rollback.md)
   and prefer rolling forward with a schema-compatible build.
3. Before configuring the production secret, obtain owner approval for the
   relevant disclosures and stored-digest retention, and put applicable consent
   and preference controls in place and verify them. The checkout policy
   acknowledgement is not analytics consent. This PR neither publishes policy
   changes nor enables hosted capture.
4. When cleared for activation, use a dedicated high-entropy backend secret
   (at least 32 bytes) in the deployment secret manager. The storefront and API
   must be same-site so credentialed checkout requests can reuse the `SameSite=Lax`
   cookie. A different browser, API host, or signing secret starts a new key.

## Expiry And Removal

The host-only cookie expires after 90 days and is not refreshed on reuse. An
authorized guest checkout with `Sec-GPC: 1` ignores it and clears it when
present. Disabling capture stops new writes and use of the
cookie; rotating the secret also invalidates prior signed cookies. A lost
initial response or failed provider call can leave a stored digest without a
browser cookie. Retrying a prepared order does not recreate it.

Those actions affect future capture, not stored attribution. Retain digests
only for the owner-approved period, independently of order retention. To remove
attribution, use the existing restricted database access and change only
`orders.guest_analytics_digest` to `NULL` for the approved scope. Confirm the
matching row count with the same filter before writing, run the update in a
transaction, and recheck the count before committing. For retention, use an
explicit UTC cutoff on `created_at`, for example:

```sql
update orders
set guest_analytics_digest = null
where guest_analytics_digest is not null
  and created_at < $1::timestamptz;
```

For a bounded set of reviewed orders, filter by those order IDs instead. Record
only authorization, scope, and row counts, not keys, digests, or contact data.
The removed rows may become unidentified in later reports. Do not delete or
reassign the orders. No automatic purge is introduced here.
