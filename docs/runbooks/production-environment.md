# Production Environment Ownership

Production uses separate Vercel projects rooted at `client/` and `backend/`.
Set values in Vercel project settings, scoped to Production, and enable the
system environment variables needed for `VERCEL_GIT_COMMIT_SHA` and
`VERCEL_DEPLOYMENT_ID`. Never place values in launch evidence.

## Backend Project

| Variable | Kind | Owner | Validation |
| --- | --- | --- | --- |
| `NODE_ENV` | config | release | exactly `production` |
| `LOG_LEVEL` | config | incident | approved bounded level |
| `CORS_ALLOWED_ORIGINS` | config | security | one exact storefront HTTPS origin |
| `ORDER_LOOKUP_BASE_URL` | config | release | storefront HTTPS base |
| `CLERK_PUBLISHABLE_KEY` | config | auth | production application |
| `CLERK_SECRET_KEY` | secret | auth | matching live application |
| `CLERK_JWT_ISSUER`, `CLERK_JWKS_URL` | config | auth | exact production issuer |
| `CLERK_JWT_AUDIENCE` | config | auth | exact API resource identifier |
| `CLERK_AUTHORIZED_PARTIES` | config | auth | exact storefront origin |
| `CLERK_WEBHOOK_SECRET` | secret | auth | production endpoint; 32+ bytes |
| `STRIPE_SECRET_KEY` | secret | payments | live account |
| `STRIPE_WEBHOOK_SECRET` | secret | payments | production endpoint; 32+ bytes |
| `STRIPE_CHECKOUT_SUCCESS_URL`, `STRIPE_CHECKOUT_CANCEL_URL` | config | payments | storefront HTTPS URLs |
| `DATABASE_URL` | secret | database | pooled TLS URL |
| `DATABASE_DIRECT_URL` | secret | database | direct TLS migration URL |
| `DATABASE_SSL_MODE` | config | database | `require` or stronger verification |
| `DATABASE_MAX_CONNECTIONS`, `DATABASE_RESERVED_CONNECTIONS`, `DATABASE_MAX_APP_INSTANCES`, `DATABASE_POOL_MAX` | config | database | satisfy startup connection budget |
| `REDIS_URL` | secret | incident | TLS `rediss://` URL |
| `BLOB_READ_WRITE_TOKEN` | secret | assets | production Blob store |
| `ASSET_UPLOAD_CALLBACK_SECRET_CURRENT` | secret | assets | current 32+ byte signer |
| `ASSET_UPLOAD_CALLBACK_KEY_ID_CURRENT` | config | assets | current key ID |
| `CRON_SECRET` | secret | incident | unique 32+ byte bearer secret |
| `MESSAGE_DELIVERY_URL`, `MESSAGE_DELIVERY_TOKEN`, `MESSAGE_WEBHOOK_SECRET` | conditional | messaging | complete group or all absent |
| `MESSAGE_FROM_EMAIL`, `MESSAGE_FROM_SMS` | conditional | messaging | at least one sender when enabled |
| `MESSAGE_CANARY_DESTINATION` | secret | messaging | fixed internal destination |

`RELEASE_SHA` and `RELEASE_DEPLOYMENT_ID` are optional overrides. Prefer Vercel's
`VERCEL_GIT_COMMIT_SHA` and `VERCEL_DEPLOYMENT_ID` system values.

## Client Project

The client owns `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, its
server-only Blob token, and the callback URL/signing values used by its upload
route. `NEXT_PUBLIC_API_URL` must be the exact API custom origin. Do not expose a
server secret through a `NEXT_PUBLIC_` name.

## GitHub Environment

The protected `production` GitHub environment stores only `VERCEL_TOKEN`,
`VERCEL_ORG_ID`, and `VERCEL_BACKEND_PROJECT_ID` for migrations. Require an
owner approval and prevent simultaneous runs. PostgreSQL credentials remain in
the backend Vercel project and are injected only by `vercel env run`.

## Rotation

Rotate exposed credentials at their provider, update Vercel, redeploy, and
verify the old value is rejected. Removing a committed value is not sufficient.
