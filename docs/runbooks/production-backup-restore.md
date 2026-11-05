# Production Backup And Restore

## Ownership And Retention

The database owner confirms the purchased DigitalOcean Managed PostgreSQL plan,
the provider's current automatic-backup schedule, and its current seven-day
retention before launch. Do not infer those properties from the App Spec. Create
an owner-controlled encrypted logical backup before launch and before each
high-risk migration. Store it in a separately permissioned object store for 30
days. The age recipient key belongs to the database recovery owner and a second
approver. Record access, checksum, retention, and deletion evidence.

## Disposable Target Preparation

Use a new non-production cluster and a least-privilege restore role with the
permissions needed by `pg_restore`, plus permission to read
`pg_control_system()`. The target database name must contain `restore`. Never use
a normal development, staging, or production database.

In the provider console or an interactive `psql` session, create only the schema
`kapchi_restore_guard`, the table `kapchi_restore_guard.target(database_name
text primary key, marker_token_sha256 text not null)`, and one row containing the
exact target database name plus the SHA-256 digest of a randomly generated
out-of-band marker token. Do not put the token in shell arguments or logs.

Supply URLs and credentials through environment variables only:

```text
RESTORE_SOURCE_DATABASE_URL
RESTORE_TARGET_DATABASE_URL
RESTORE_TARGET_CONFIRM_DATABASE
RESTORE_TARGET_MARKER_TOKEN
RESTORE_TARGET_ALLOWLIST
RESTORE_PROTECTED_IDENTITIES
RESTORE_ENCRYPTED_ARTIFACT_PATH
RESTORE_AGE_RECIPIENT
RESTORE_AGE_IDENTITY_FILE
RELEASE_SHA
```

Fingerprint source and target. The command outputs hashes only:

```sh
node scripts/restore-drill.mjs fingerprint
```

Place the target identity hash in the out-of-band disposable allowlist. Place
the identity and cluster hashes for every normal, staging, and production
database in `RESTORE_PROTECTED_IDENTITIES`. Then run the non-mutating guard:

```sh
node scripts/restore-drill.mjs guard
```

The guard connects live and rejects a same-cluster alias, protected identity,
missing/mismatched marker, typed-name mismatch, nonempty target, or non-allowlisted
target. It never drops a database.

## Drill

Install the same PostgreSQL major-version client as the source plus `age`. Run:

```sh
node scripts/restore-drill.mjs run
```

The custom-format dump streams directly through age encryption into a mode-0600
artifact. No plaintext dump is written. Decryption streams into
`pg_restore --exit-on-error --single-transaction --no-owner --no-acl`. The tool
then runs the read-only migration check and bounded counts for orders, Stripe
inbox, refunds/manual review, messages, notifications, reservations, and shipping
exports. It never calls a provider or runs workers against the copy.

Record the sanitized summary, encrypted artifact SHA-256, migration result,
provider managed-restore evidence, and reconciliation assessment. The local tool
does not replace the required managed-provider restore-to-new-cluster drill from
the last 30 days. Destroy the disposable target separately in the provider
console, attach destruction evidence, and remove the encrypted artifact when its
approved drill retention ends. Never automate database deletion.
