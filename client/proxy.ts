import { clerkMiddleware } from '@clerk/nextjs/server'

export default clerkMiddleware()

export const config = {
  matcher: [
    // Fastify owns API authentication; keep proxy rewrites available during Clerk outages.
    '/((?!_next|api(?:/|$)|cart(?:/|$)|checkout(?:/|$)|listings(?:/|$)|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
  ],
}
