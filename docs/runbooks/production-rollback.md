# Production Rollback And Roll-Forward

## Compatibility Gate

Before promotion, prove the previous client and API release (N-1) can read and
write safely against release N's schema. Production migrations are additive and
expand/contract: destructive cleanup belongs to a later release after the old
code is retired. Record the test deployment, current migration digest, N/N-1 API
contract result, and owner approval.

## Application Rollback

1. Release owner declares the incident and pauses promotion.
2. Promote the previous known-good Vercel deployment first so browsers stop
   sending the new contract.
3. Confirm the N/N-1 compatibility evidence is still valid.
4. If compatible, select the previous digest-pinned DigitalOcean deployment for
   the API and singleton worker. Do not run reverse migrations.
5. Wait for `/health` and `/ready`, then run the external verifier with the old
   release SHA and image digest.
6. Reconcile Stripe inbox, refunds, messages, notifications, reservations, and
   shipping-export retention before reopening the rollout.

Keep webhook ingress available when possible. Pause workers only when replay-safe
processing cannot be guaranteed, and record the pause/restart timestamps. Never
discard provider events or retry records.

## Roll Forward And Write Freeze

If N-1 is incompatible with the current schema, do not deploy it. Disable new
checkout/admin mutations at the routing or application control plane, preserve
signed webhook ingress, stop mutation-capable workers when needed, and deploy an
additive repair from the same controlled pipeline. The database owner and release
owner jointly approve the repair. Restoring a database is disaster recovery, not
a routine application rollback.

## Decision Evidence

Record the incident link, customer impact window, release and image identities,
compatibility decision, client/API/worker deployment IDs, migration state,
webhook/job handling, verifier output, reconciliation output, and final owner
signatures. A compatibility failure or missing reconciliation is `NO-GO`.
