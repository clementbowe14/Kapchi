# Issue 114 Acceptance Evidence

Repository controls prepare production launch; they do not prove that external
provider resources exist. Issue 114 remains open until an operator completes and
validates an immutable launch record.

| Acceptance area | Repository proof | Production proof | Owner | Pass condition |
| --- | --- | --- | --- | --- |
| Topology and environment | Dockerfile, App Spec validator, environment inventory | Vercel/DO links, same-site domains, redacted variable-name exports | release owner | one owner/platform per component and exact HTTPS origins |
| Secrets | pinned Gitleaks workflow and template validators | GitHub protection status, redacted provider exports, rotation timestamps | security owner | no committed values and all required names configured |
| Migrations | runtime-slice locking/checksum tests; predeploy command | apply/check job link with matching SHA and digest | database owner | no pending, null checksum, or drift |
| Health and traffic | runtime health tests and external verifier tests | public results and candidate dependency-failure evidence | release owner | expected SHA/digest, all ready before promotion |
| Auth and providers | CORS/auth tests and canary contracts | Clerk, Stripe, Blob, messaging evidence and cleanup | domain owners | expected success/denial, no commerce mutation |
| Backup/restore | restore guard tests | encrypted backup plus managed restore drill within 30 days | database owner | integrity and reconciliation pass; target destroyed |
| Rollback | rollback runbook | N/N-1 staged rehearsal | release/database owners | previous releases compatible or launch blocked |
| Alerts | inventory/query/template validators | exported config, test notification, ack, recovery | incident owner | every stable alert ID reaches both destinations |
| Launch decision | launch-record validator | immutable signed record | release owner | all evidence fresh/pass and no blockers for `GO` |
| Unsafe commands | production mutation-spy tests across integrated slices | preflight output | release owner | unsafe reset/seed/sync commands fail before mutation |

Each provider evidence item includes its provider URL/ID, a redacted configuration
export, safe test timestamp, received incident link, acknowledgement timestamp,
and recovery timestamp. Never attach tokens, cookies, secrets, database URLs,
customer data, payload bodies, or private Blob URLs.
