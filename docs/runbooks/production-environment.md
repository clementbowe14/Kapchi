# Production Environment Ownership

Production uses a Vercel storefront and a separately deployed DigitalOcean
Fastify API. Browser traffic requires same-site HTTPS custom domains. Values are
configured only in provider secret/config stores; this inventory contains names
and validation rules, never values.

| Variable | Platform | Scope | Class | Required | Rotation owner | Validation |
| --- | --- | --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Vercel | build/runtime | config | yes | auth owner | live publishable key; same Clerk instance as backend |
| `NEXT_PUBLIC_API_BASE_URL` | Vercel | build/runtime | config | yes | release owner | exact HTTPS API origin, no path |
| `BACKEND_INTERNAL_URL` | Vercel | runtime | config | yes | release owner | same public HTTPS API origin |
| `CLERK_SECRET_KEY` | Vercel | runtime | secret | yes | auth owner | live key; never exposed to browser build |
| `BLOB_READ_WRITE_TOKEN` | Vercel | runtime | secret | conditional | assets owner | choose token or OIDC, never both |
| `VERCEL_OIDC_TOKEN` | Vercel | runtime | secret | conditional | assets owner | requires `BLOB_STORE_ID`; mutually exclusive with token |
| `BLOB_STORE_ID` | Vercel | runtime | config | conditional | assets owner | required with OIDC |
| `ASSET_UPLOAD_CALLBACK_SECRET_CURRENT` | Vercel/API | runtime | secret | yes | assets owner | same value on both platforms; at least 32 bytes |
| `ASSET_UPLOAD_CALLBACK_KEY_ID_CURRENT` | Vercel/API | runtime | config | yes | assets owner | `^[A-Za-z0-9_-]{8,64}$`; never reassigned |
| `ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS` | Vercel/API | runtime | secret | optional | assets owner | only during a bounded rotation overlap |
| `ASSET_UPLOAD_CALLBACK_KEY_ID_PREVIOUS` | Vercel/API | runtime | config | optional | assets owner | required with previous secret |
| `ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS_EXPIRES_AT` | Vercel/API | runtime | config | optional | assets owner | no more than 24 hours after rotation |
| `NODE_ENV` | DigitalOcean | runtime | config | yes | release owner | exactly `production` |
| `HOST` | DigitalOcean | runtime | config | yes | release owner | `0.0.0.0` |
| `PORT` | DigitalOcean | runtime | config | yes | release owner | matches App Spec port |
| `LOG_LEVEL` | DigitalOcean | runtime | config | yes | incident owner | approved bounded level; no debug at launch |
| `RELEASE_SHA` | DigitalOcean | runtime | config | yes | release owner | full immutable Git SHA |
| `RELEASE_IMAGE_DIGEST` | DigitalOcean | runtime | config | yes | release owner | exact `sha256:` image digest shared by API/jobs/worker |
| `PRODUCTION_CLIENT_URL` | DigitalOcean | runtime | config | yes | release owner | exact same-site HTTPS storefront origin |
| `PRODUCTION_API_URL` | DigitalOcean | runtime | config | yes | release owner | exact same-site HTTPS API origin |
| `CORS_ALLOWED_ORIGINS` | DigitalOcean | runtime | config | yes | security owner | exactly one production storefront origin |
| `ORDER_LOOKUP_BASE_URL` | DigitalOcean | runtime | config | yes | release owner | exact HTTPS storefront order URL base |
| `CLERK_PUBLISHABLE_KEY` | DigitalOcean | runtime | secret | yes | auth owner | live key matching client and issuer |
| `CLERK_SECRET_KEY` | DigitalOcean | runtime | secret | yes | auth owner | live key matching publishable key |
| `CLERK_JWT_ISSUER` | DigitalOcean | runtime | config | yes | auth owner | exact production issuer HTTPS URL |
| `CLERK_JWKS_URL` | DigitalOcean | runtime | config | yes | auth owner | HTTPS and owned by configured issuer |
| `CLERK_JWT_AUDIENCE` | DigitalOcean | runtime | config | yes | auth owner | exact API resource identifier, not storefront URL |
| `CLERK_AUTHORIZED_PARTIES` | DigitalOcean | runtime | config | yes | auth owner | exact storefront origin used for `azp` |
| `CLERK_WEBHOOK_SECRET` | DigitalOcean | runtime | secret | yes | auth owner | production endpoint secret; at least 32 bytes |
| `STRIPE_SECRET_KEY` | DigitalOcean | runtime | secret | yes | payments owner | live key; account fingerprint verified during preflight |
| `STRIPE_WEBHOOK_SECRET` | DigitalOcean | runtime | secret | yes | payments owner | live endpoint secret; at least 32 bytes |
| `STRIPE_API_VERSION` | DigitalOcean | runtime | config | yes | payments owner | pinned supported version |
| `STRIPE_CHECKOUT_SUCCESS_URL` | DigitalOcean | runtime | config | yes | payments owner | HTTPS storefront URL |
| `STRIPE_CHECKOUT_CANCEL_URL` | DigitalOcean | runtime | config | yes | payments owner | HTTPS storefront URL |
| `DATABASE_URL` | DigitalOcean | runtime | secret | yes | database owner | pooled TLS URL; never logged |
| `DATABASE_DIRECT_URL` | DigitalOcean | runtime | secret | yes | database owner | direct TLS URL required by production migrations |
| `DATABASE_SSL_MODE` | DigitalOcean | runtime | config | yes | database owner | reject `disable` and `no-verify` |
| `DATABASE_MAX_CONNECTIONS` | DigitalOcean | runtime | config | yes | database owner | reconciled with plan limit, reserve, pools, and instances |
| `DATABASE_POOL_MAX` | DigitalOcean | runtime | config | yes | database owner | bounded below remaining connection budget |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | DigitalOcean | runtime | config | yes | database owner | bounded positive integer |
| `DATABASE_CONNECTION_TIMEOUT_MS` | DigitalOcean | runtime | config | yes | database owner | bounded below platform startup timeout |
| `REDIS_URL` | DigitalOcean | runtime | secret | yes | incident owner | TLS `rediss://` production endpoint |
| `BLOB_READ_WRITE_TOKEN` | DigitalOcean | runtime | secret | yes | assets owner | backend token for configured production store |
| `MESSAGE_DELIVERY_URL` | DigitalOcean | runtime | config | conditional | messaging owner | HTTPS; enables all-or-none messaging group |
| `MESSAGE_DELIVERY_TOKEN` | DigitalOcean | runtime | secret | conditional | messaging owner | required when gateway configured |
| `MESSAGE_WEBHOOK_SECRET` | DigitalOcean | runtime | secret | conditional | messaging owner | required with gateway; at least 32 bytes |
| `MESSAGE_FROM_EMAIL` | DigitalOcean | runtime | config | conditional | messaging owner | at least one approved sender required |
| `MESSAGE_FROM_SMS` | DigitalOcean | runtime | config | conditional | messaging owner | at least one approved sender required |
| `MESSAGE_CANARY_DESTINATION` | DigitalOcean | runtime | secret | yes | messaging owner | fixed allowlisted internal destination only |

## Evidence And Rotation

Export variable **names**, scopes, and last-rotation timestamps from each provider;
redact all values. The release owner confirms GitHub secret scanning and push
protection, the pinned Gitleaks workflow, and the provider exports in the launch
record. Rotate current/previous callback keys using the 24-hour overlap in the
approved specification. Rotate webhook secrets by adding the new endpoint secret,
confirming signed delivery, and only then retiring the old value.

Production validation must reject test/placeholder Stripe or Clerk keys,
non-HTTPS provider URLs, insecure database SSL, non-TLS Redis, short shared
secrets, incomplete messaging groups, and conflicting Blob strategies. Errors
contain variable names and bounded codes only.
