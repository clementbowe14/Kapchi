import { clerkMiddleware } from '@clerk/nextjs/server'

export default clerkMiddleware()

export const config = {
  matcher: [
    // Fastify owns protected data authorization; keep API rewrites and data-free
    // commerce/admin shells available while Clerk's server middleware is degraded.
    '/((?!_next|admin(?:/|$)|api(?:/|$)|cart(?:/|$)|checkout(?:/|$)|listings(?:/|$)|policies(?:/|$)|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
  ],
}
