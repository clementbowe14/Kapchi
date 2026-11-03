# Kapchi MVP Launch Plan

Last updated: November 3, 2026

## Current position

Kapchi's customer purchase foundations and backend order-management contracts
are largely complete. The remaining launch work is concentrated in admin
fulfillment workflows, transactional communication, shipping operations,
customer policies, production readiness, and the final staging release gate.

The admin-order dashboard milestone is complete:

1. [PR #121](https://github.com/clementbowe14/Kapchi/pull/121) is merged into
   `main` and closes [issue #19](https://github.com/clementbowe14/Kapchi/issues/19).
2. [PR #126](https://github.com/clementbowe14/Kapchi/pull/126) is the active
   consolidation PR for issue #22 and backend subissue #122. It brings the
   previously reviewed backend and frontend stack onto current `main`.

The consolidated commits previously passed the local database, unit, lint,
typecheck, production build, GitGuardian, and Vercel preview checks.
Authenticated Clerk desktop/mobile browser coverage and the isolated real E2E
reset remain release evidence for issue #22.

## Ordered MVP launch work

| Order | Work | Current status | Exit condition |
| --- | --- | --- | --- |
| 1 | [#19 Admin ongoing orders dashboard](https://github.com/clementbowe14/Kapchi/issues/19) | Completed by merged PR #121 | Keep the dashboard covered by the downstream order-handling regression suite. |
| 2 | [#22 Admin order handling workflow](https://github.com/clementbowe14/Kapchi/issues/22) | Consolidation PR #126 targets `main`; reviewed local suites pass | Authenticated E2E passes and PR #126 merges. |
| 3 | [#116 Transactional confirmations and fulfillment updates](https://github.com/clementbowe14/Kapchi/issues/116) | Open; backend dependencies #12 and #21 are complete | Durable, idempotent confirmation and lifecycle notifications pass retry, duplicate, missing-contact, and privacy-safe logging tests. |
| 4 | [#29 Pirate Ship shipping-label workflow](https://github.com/clementbowe14/Kapchi/issues/29) | Open | Ready-to-ship orders export safely, human approval precedes purchase, and confirmed tracking returns to Kapchi. |
| 5 | [#117 Customer shipping, returns, privacy, and terms policies](https://github.com/clementbowe14/Kapchi/issues/117) | Implementation and tests complete on `codex/issue-117-store-policies`; publication is gated | Record explicit owner approval for bundle `2026-11-03.1`, expire the four detected legacy Stripe sessions without policy evidence, rerun the enforcement preflight, and merge the reviewed PR. |
| 6 | [#85 Persistence and staging test fixtures](https://github.com/clementbowe14/Kapchi/issues/85) | Partially covered by local seed data; staging scope remains | Repeatable isolated fixtures support release-gate scenarios without production data. |
| 7 | [#114 Production deployment, migration, backup, and rollback runbook](https://github.com/clementbowe14/Kapchi/issues/114) | Open | Owners, secrets, migration, health routing, backup/restore, rollback, alerts, and the go/no-go checklist are verified. |
| 8 | [#115 Staging purchase and fulfillment release gate](https://github.com/clementbowe14/Kapchi/issues/115) | Final gate; depends on #22, #85, #101, and #103 | Critical guest/authenticated purchase, customization, payment, admin, shipping, refund, and observability paths pass in staging. |

## Completed foundations

- Guest and authenticated cart and checkout flows
- Stripe payment and webhook handling
- Product customization and production estimates
- Customer-safe order lookup
- Private customization assets
- Admin authorization and guarded mutations
- Admin order read APIs and lifecycle transitions
- Messaging backend contracts
- Refund processing and reconciliation
- PostgreSQL, Redis, and local seed data

## Work after the MVP

These issues remain valuable but are not required to prove the first complete
sell-to-fulfill path:

- Promotions (#102)
- Analytics aggregates (#104)
- Broader dashboard alignment (#99)
- Fabric inventory management UI (#33)
- Automatic Stripe catalog creation (#31)
- Admin customer messaging UI (#20)
- Store-item customization and removal controls (#17 and #18)
- Pirate Ship browser assistant (#30)

Manual catalog and inventory administration can bridge the initial launch when
the process is documented.

## Immediate next steps

1. Generate a valid Clerk admin storage state at `client/.auth/admin.json`.
2. Configure an isolated loopback `E2E_DATABASE_URL` ending in `_e2e` and set
   `E2E_ADMIN_AUTH_SUBJECT`.
3. Run the authenticated desktop/mobile workflow and real Fastify/PostgreSQL
   order-handling E2E tests.
4. Review and merge consolidation PR #126 into `main`.
5. Begin the three-reviewer specification process for issue #116.
