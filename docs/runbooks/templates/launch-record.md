# Production Launch Record

Create an immutable copy of `launch-record.json` for each release. Replace every
placeholder, keep secrets and customer data out of the record, and attach only
HTTPS or provider-console evidence references. The API and worker image digests
must be identical and every evidence item must use the release's full Git SHA.

Validate the working record before any decision:

```sh
node scripts/validate-launch-record.mjs --record path/to/release-record.json
```

`GO` is valid only after all fifteen evidence sections pass, the observation
window ends, no blockers remain, and the release owner signs the record. A
`NO-GO` record remains useful evidence and must identify at least one blocker or
non-passing check. The validator checks shape, consistency, freshness, and URI
format; it does not follow links or claim provider evidence exists.
