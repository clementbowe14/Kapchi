const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export const AUTH_ROUTES = {
  home: "/",
  signIn: "/sign-in",
  signUp: "/sign-up",
} as const;

type AuthUserLike = {
  emailAddresses?: Array<{
    emailAddress?: string | null;
  }> | null;
  firstName?: string | null;
  primaryEmailAddress?: {
    emailAddress?: string | null;
  } | null;
  username?: string | null;
};

export function getClerkPublishableKey() {
  if (!publishableKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY. Add it to client/.env before rendering ClerkProvider.",
    );
  }

  return publishableKey;
}

export function getUserDisplayName(user: AuthUserLike | null | undefined) {
  const firstName = user?.firstName?.trim();

  if (firstName) {
    return firstName;
  }

  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress;

  if (email) {
    return email;
  }

  return user?.username ?? "there";
}
