# Production Alerts

Better Stack owns external uptime and log-derived alerts. Vercel owns function,
deployment, and cron observability. The actual PostgreSQL and Redis providers
own resource-level saturation and availability alerts. Every stable alert ID in
`deploy/alerts/inventory.json` routes to primary and secondary destinations.

## Public Readiness

Monitor HTTPS `/ready` from at least two regions. Page after two consecutive
failures or a non-ready response. Store only bounded dependency codes.

## Vercel Functions And Cron

Alert on backend 5xx rate, function timeout/duration, failed deployments, and
`cron.operation.failed`. Vercel Cron has no automatic retry guarantee and may
invoke a job more than once; the Redis lock and service idempotency protect work,
while alerting calls for operator review.

## PostgreSQL And Redis

Configure provider-native connection, CPU/storage, and availability thresholds
for the purchased plans. Better Stack also derives `DATABASE_UNAVAILABLE`,
`MIGRATION_DRIFT`, and `REDIS_UNAVAILABLE` from redacted readiness/log events.

## Stripe And Durable Work

Page when Stripe webhook processing is exhausted or stale, refund reconciliation
requires review, messages remain failed/stale, or operational-health counts are
nonzero. Never export payloads, signatures, customer data, URLs, keys, or values.

## Deployment And Migration

GitHub environment reviewers receive migration workflow failures. Vercel alerts
cover failed promotions. The release owner stops promotion on either signal and
records sanitized evidence.

## Testing

Before GO, safely trigger each alert ID, verify both destinations, acknowledge
it, and attach an HTTPS/provider reference to the launch record. Do not lower a
threshold permanently to manufacture evidence.
