# Production Alerts

`deploy/alerts/inventory.json` is the stable alert contract. Better Stack owns
external uptime and log alerts; DigitalOcean owns App Platform and managed
database alerts. Validate repository definitions with:

```sh
node scripts/validate-alerts.mjs
```

The `--require-evidence` mode is used only on an operator copy whose evidence
fields contain real HTTPS provider links.

## Better Stack

Create HTTPS monitors for the storefront, API `/health`, and API `/ready` with
TLS verification. Configure `/ready` from at least one US and one EU region. Two
consecutive failures in both regions page; one-region failure warns only. Forward
redacted Fastify and worker JSON logs to a Better Stack source. Implement the
checked-in query definitions for backend 5xx count/percentage, Stripe webhook
failure, Redis failure, and operational/background failure.

Use the named incident owner as primary and one independent secondary channel.
Test log alerts with a uniquely tagged synthetic log event. Test uptime alerts
against a staged release endpoint, never by interrupting the production domain.

## DigitalOcean

The App Spec declares only rules supported in source: deployment/domain/scaling
failures and component CPU, memory, restart, and latency signals. In the
DigitalOcean Alerts UI/API, separately configure failed job invocation and any
other app-level controls not represented by the template. Export redacted alert
configuration and use provider test notifications or a disposable failed job.

Configure PostgreSQL connection saturation from the managed database's current
connections metric divided by the recorded plan connection limit. Alert at 80%
for five minutes. Reconcile the plan limit with reserved connections, API/worker
instance counts, `DATABASE_MAX_CONNECTIONS`, and each pool maximum. Do not infer
connection saturation from application logs.

## Response Sections

### Backend 5xx

Page at five responses or two percent in five minutes. Correlate bounded request
IDs and release identity; never search by customer payload.

### Public Readiness

Stop rollout on two consecutive failures from both regions. Inspect stable failed
dependency codes and the current release/image identity.

### PostgreSQL

Halt deployment and background work on readiness failure or 80% saturation.
Verify provider status and pool budgets before any scaling change.

### Redis

Protect guest/cart flows on two minutes of readiness or connection failure.
Inspect the managed service without logging keys, commands, or values.

### Stripe Webhook

Reconcile provider event IDs through bounded admin tooling when any
`stripe.webhook.failed` event or exhausted inbox count appears.

### Background Jobs

Inspect stable category codes when operational health reports exhausted work or a
worker operation fails. The health command observes work; it does not process it.

### Deployment And Migration

Any failed deployment, predeploy migration, or scheduled health invocation blocks
`GO`. Record sanitized migration error codes and deployment/job IDs only.

## Evidence

For each stable alert ID, record the provider URL/ID, redacted configuration,
timestamped safe test signal, received incident/notification link,
acknowledgement, and recovery. Confirm both primary and secondary delivery paths.
Never test by interrupting production databases, Redis, workers, or customer
traffic.
