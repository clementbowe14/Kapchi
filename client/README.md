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
```

Notes:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is required for the Clerk frontend provider.
- `CLERK_SECRET_KEY` is also currently expected by the app setup.
- Do not commit real production secrets.

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
