# Staging Release Gate

This runbook defines the issue #115 evidence lifecycle. The gate proves one
reviewed commit against one exact storefront deployment, one exact API
deployment, and attested staging-only providers. It does not authorize testing
against production.

The machine-readable source of scenario IDs is
`deploy/staging-release-scenarios.json`. Do not invent IDs in a workflow or
record. A registry change requires a new `registryVersion` and updated validator
tests.

## Trust boundary

Candidate code runs secretless tests. A credentialed job must use trusted
orchestration from the protected default branch and may deploy only a candidate
SHA proven reachable from the protected release branch. Candidate-controlled
scripts never receive provider management credentials.

The protected `staging` GitHub environment supplies reviewer identity and the
expected Vercel, database, Stripe test account, Clerk test instance, Blob store,
Redis instance, and messaging destination identities. Record only SHA-256
identity hashes. Never place URLs containing credentials, query strings, or
fragments in evidence.

## Record types

All records have a maximum 24-hour window and preserve the same attempt ID,
registry version, commit SHA, attempt creation/expiry timestamps, storefront
deployment ID, and API deployment ID.
Reruns create a new attempt ID and never overwrite earlier artifacts.

### 1. Prepared record

Trusted orchestration emits `recordType: prepared` after deterministic candidate
tests and deployed staging probes finish. It contains every registry scenario.
Candidate and staging proofs are `pass` or `fail`; provider proofs remain
`pending`. Each deterministic proof references a GitHub artifact with a SHA-256
digest and GitHub OIDC attestation metadata. `providerObjectBindings` records one
safe provider/object hash for every provider scenario so later observations
cannot be substituted from another attempt.

The JSON file in `docs/runbooks/templates/staging-gate-record.json` is a shape
template, not evidence and not a passing record. The prepare workflow expands
`scenarioResults` from the registry and replaces every placeholder.

Canonicalize and upload the prepared record, then attest its SHA-256 digest.
The record does not contain its own digest. Retain it for at least 30 days.

### 2. Manual provider record

An authorized staging reviewer starts a separate environment-protected workflow
using the immutable prepared artifact ID. That workflow verifies the prepared
artifact digest and provenance before accepting observations.

The manual record contains only scenarios whose registry proof modes include
`provider`. Each provider result must be `pass` or `fail` and must reference:

- a provider object URL on an exact host listed in the registry;
- a one-way hash of the provider object identifier; and
- a sanitized GitHub evidence artifact with digest and attestation metadata.

Provider URLs must use HTTPS and may not contain credentials, query strings, or
fragments. Sanitized captures must omit tokens, cookies, addresses,
customization text, filenames, private Blob URLs, and provider payloads. The
workflow records the authenticated GitHub actor; typed owner names are not
accepted.

Capture provider evidence before cleanup. Canonicalize, upload, digest, and
attest the manual record without embedding its own digest.

### 3. Final record

Trusted default-branch code retrieves the prepared and manual artifacts by
workflow run and artifact ID, verifies their digest attestations, and copies the
validated proof results into `recordType: final`. It then performs and verifies
cleanup before deriving the decision.

Required cleanup outcomes are:

| Resource | Retention | Passing outcome |
| --- | --- | --- |
| Temporary aliases | deletable | deleted |
| Disposable database | deletable | deleted |
| Run-prefixed Blob objects | deletable | deleted |
| Ephemeral Clerk users and sessions | deletable | deleted |
| Stripe test objects | provider-retained | terminal-isolated |
| Messaging artifacts | provider-retained | terminal-isolated |

Any failed cleanup item forces `NO-GO`. The final decision is derived by
`scripts/validate-staging-gate.mjs`; an operator cannot set `GO`. `GO` requires
every registered proof to pass, all cleanup to verify, no blockers, and
finalization before expiry. The generated final record is retained and attested
as the staging-gate artifact used by the production launch record's `smoke`
evidence.

## Validation

Validate any prepared, manual, or final record with trusted repository code:

```sh
node scripts/validate-staging-gate.mjs \
  --registry deploy/staging-release-scenarios.json \
  --record /path/to/staging-gate-record.json
```

Before publishing a final result, validate all immutable source records together:

```sh
node scripts/validate-staging-gate.mjs \
  --registry deploy/staging-release-scenarios.json \
  --prepared-record /path/to/prepared.json \
  --manual-record /path/to/manual.json \
  --final-record /path/to/final.json
```

Bundle validation additionally recalculates canonical prepared/manual record
digests, binds provider observations to the prepared object hashes, proves that
attempt, provider, SHA, deployment, and time-window identities match, and
requires every final proof to be byte-for-byte equal to its immutable source.

For deterministic replay in tests or incident review, pass a validation clock:

```sh
node scripts/validate-staging-gate.mjs \
  --registry deploy/staging-release-scenarios.json \
  --record /path/to/staging-gate-record.json \
  --now 2026-11-14T12:00:00.000Z
```

Validation fails on unknown, missing, or duplicate scenarios; missing or
duplicate proof modes; mixed commit or deployment identity; stale records;
unsafe provider references; invalid artifact digests or attestations; pending
final proof; incomplete cleanup; blockers under `GO`; and operator-authored
decisions.

## Failure handling

On cancellation, expiry, or any failed phase, run idempotent cleanup. A cleanup
failure remains `NO-GO`, alerts the release owner, and leaves the 24-hour TTL
cleanup as a fallback. Never reuse a failed attempt's ID, artifacts, aliases, or
fixture namespace. Preserve all prior attempt records for audit.
