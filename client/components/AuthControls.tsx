"use client";

import { ClerkLoaded, ClerkLoading, UserButton, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { AUTH_ROUTES, getUserDisplayName } from "@/lib/clerk";

type AuthControlsProps = {
  variant: "home" | "navbar";
};

function SignInLink({
  className,
  size = "default",
}: {
  className?: string;
  size?: "default" | "large";
}) {
  const sizeClasses =
    size === "large"
      ? "h-12 px-6 text-base"
      : "h-10 px-4 text-sm sm:text-base";

  return (
    <Link
      href={AUTH_ROUTES.signIn}
      className={`inline-flex items-center justify-center rounded-full bg-[#b49872] font-medium text-white transition hover:bg-[#a1845f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2 ${sizeClasses}${className ? ` ${className}` : ""}`}
    >
      Sign In
    </Link>
  );
}

function LoadingSkeleton({ variant }: AuthControlsProps) {
  if (variant === "navbar") {
    return (
      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-5 w-28 animate-pulse rounded-full bg-slate-200" />
        <span className="h-9 w-9 animate-pulse rounded-full bg-slate-200" />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-4" aria-hidden="true">
      <span className="h-12 w-32 animate-pulse rounded-full bg-slate-200" />
    </div>
  );
}

function LoadedControls({ variant }: AuthControlsProps) {
  const { isSignedIn, user } = useUser();
  const displayName = getUserDisplayName(user);

  if (!isSignedIn) {
    return <SignInLink size={variant === "home" ? "large" : "default"} />;
  }

  if (variant === "home") {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4 text-base font-medium text-slate-900">
        Welcome, {displayName}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <p className="hidden text-sm font-medium text-slate-700 sm:block">
        Welcome, {displayName}
      </p>
      <UserButton />
    </div>
  );
}

export function AuthControls(props: AuthControlsProps) {
  return (
    <>
      <ClerkLoading>
        <LoadingSkeleton {...props} />
      </ClerkLoading>
      <ClerkLoaded>
        <LoadedControls {...props} />
      </ClerkLoaded>
    </>
  );
}
