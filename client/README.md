# Kapchi Frontend

This is the frontend application for Kapchi, built with:

- Next.js 16
- React 19
- Tailwind CSS 4
- Clerk for authentication

## Requirements

- Node.js `>= 20.9.0`
- npm

If your shell is using an older Node version, switch first. Example with `nvm`:

```bash
nvm use 22
```

## Environment Variables

Create a local env file in `client/.env`:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=your_publishable_key
CLERK_SECRET_KEY=your_secret_key
BLOB_READ_WRITE_TOKEN=vercel_blob_read_write_token
ASSET_UPLOAD_CALLBACK_SECRET=replace_me_shared_callback_secret
BACKEND_INTERNAL_URL=http://localhost:4000
# Optional for full local Vercel Blob callbacks through a tunnel:
# VERCEL_BLOB_CALLBACK_URL=https://your-ngrok-domain.ngrok-free.app
```

Notes:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is required for the Clerk frontend provider.
- `CLERK_SECRET_KEY` is also currently expected by the app setup.
- `BLOB_READ_WRITE_TOKEN` is used by the Next.js Blob upload route to issue
  short-lived browser upload tokens.
- `ASSET_UPLOAD_CALLBACK_SECRET` must match the backend value so completed Blob
  uploads can finalize the canonical asset row.
- `BACKEND_INTERNAL_URL` points the Next.js Blob route at Fastify for upload
  authorization and metadata persistence.
- Do not commit real production secrets.

## Customer Image Uploads

Customer customization uploads use the Vercel Blob client SDK. The browser first
asks Fastify for an upload intent through `/api/assets/upload-intents`; Fastify
validates the cart/listing/customization context and creates a pending
provider-neutral asset row. The browser then uploads directly to Vercel Blob
through `/api/blob/upload`. That Next.js route uses Vercel's `handleUpload`
helper only as the Blob transport adapter and calls Fastify again when Vercel
reports completion.

Frontend code should save the returned `assetId` with customization/cart/order
data. Do not store raw Blob URLs in customization payloads.

## Install Dependencies

From the `client` directory:

```bash
npm install
```

## Run the App

Start the development server:

```bash
npm run dev
```

The app will be available at:

```txt
http://localhost:3000
```

## Other Commands

Run linting:

```bash
npm run lint
```

Create a production build:

```bash
npm run build
```

Start the production build locally:

```bash
npm run start
```

## Project Structure

Important directories:

- `app/` — App Router pages and layouts
- `components/` — shared UI components
- `lib/` — shared frontend utilities
- `public/` — static assets

## Features Currently Wired

- Clerk authentication
- Responsive Kapchi navbar
- Sign-in and sign-up pages
- Dedicated user profile page
- Placeholder cart, orders, and about pages

## Common Issues

### Node version errors

If you see errors related to Next.js or unsupported engines, check:

```bash
node -v
```

Next.js 16 requires a modern Node version.

### Clerk config errors

If the app crashes on startup with a Clerk config error, verify that `client/.env` exists and contains valid Clerk keys.

### Build issues while offline

The app uses `next/font/google` for Geist. Production builds may fail in restricted or offline environments because the font files are fetched during build.
