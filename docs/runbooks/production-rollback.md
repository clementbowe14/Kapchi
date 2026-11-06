# Production Rollback

## Compatibility Gate

The database owner decides whether the current schema is backward compatible
with the previous backend deployment. This decision precedes any Vercel rollback.
Database migrations are never reversed automatically.

## Application Rollback

When compatible:

1. Freeze new promotions and record the incident timeline.
2. Select the previous backend deployment in Vercel and perform Instant Rollback.
3. Verify `/health`, `/ready`, release identity, protected routes, and provider connectivity.
4. Confirm which cron configuration is active and disable affected schedules if
   their operation is incompatible with the current schema.
5. Roll back the client deployment only when its API contract requires it.
6. Run smoke checks and observe all alerts before resolving the incident.

## Roll Forward And Write Freeze

When incompatible, do not select an older backend. Disable mutation traffic and
scheduled writes where operationally possible, preserve webhooks for controlled
replay, diagnose migration state, prepare a forward fix from reviewed source,
and run the protected migration workflow. Restore from backup only under the
database incident procedure and only to a separately approved target first.

Record both Vercel deployment IDs, the full Git SHA, operator, timestamps,
compatibility decision, and sanitized evidence. Never record secrets or customer
payloads.
