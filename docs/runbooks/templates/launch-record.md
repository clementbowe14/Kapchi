# Production Launch Record

Create an immutable copy of `launch-record.json` for each release. Replace every
placeholder, keep secrets and customer data out of the record, and attach only
HTTPS or provider-console evidence references. Record the distinct client and
backend Vercel deployment IDs, and use the release's full Git SHA everywhere.

Validate the working record before any decision:

```sh
node scripts/validate-launch-record.mjs \
  --record path/to/release-record.json \
  --staging-gate-bundle path/to/staging-gate-bundle \
  --staging-gate-registry deploy/staging-release-scenarios.json
```

`GO` is valid only after all fifteen evidence sections pass, the observation
window ends, no blockers remain, and the release owner signs the record. A
`NO-GO` record remains useful evidence and must identify at least one blocker or
non-passing check. The validator does not trust copied status text or fetch
evidence from links. It validates the locally downloaded artifact bundle,
recomputes its derived reports, checks artifact bindings, and rejects stale or
incomplete evidence.
