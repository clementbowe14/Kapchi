"use client";

import {
  ClerkLoaded,
  ClerkLoading,
  SignOutButton,
  UserButton,
  useUser,
} from "@clerk/nextjs";
import Link from "next/link";
import { ChevronDownIcon } from "@/components/NavIcons";
import { AUTH_ROUTES, getUserDisplayName } from "@/lib/clerk";

type NavbarAuthProps = {
  mobile?: boolean;
  onNavigate?: () => void;
};

function LoadingState({ mobile = false }: NavbarAuthProps) {
  if (mobile) {
    return (
      <div
        className="rounded-3xl border border-white/55 bg-white/55 p-4"
        aria-hidden="true"
      >
        <div className="flex items-center gap-3">
          <span className="h-11 w-11 animate-pulse rounded-full bg-slate-200" />
          <div className="space-y-2">
            <span className="block h-4 w-24 animate-pulse rounded-full bg-slate-200" />
            <span className="block h-4 w-32 animate-pulse rounded-full bg-slate-200" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <span className="h-10 w-24 animate-pulse rounded-full bg-slate-200" />
      <span className="h-10 w-10 animate-pulse rounded-full bg-slate-200" />
    </div>
  );
}

function SignInLink({
  mobile = false,
  onNavigate,
}: NavbarAuthProps) {
  const className = mobile
    ? "inline-flex h-12 w-full items-center justify-center rounded-2xl bg-[#b49872] px-5 text-base font-semibold text-white transition hover:bg-[#a1845f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2"
    : "inline-flex h-11 items-center justify-center rounded-full bg-[#b49872] px-5 text-sm font-semibold text-white transition hover:bg-[#a1845f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2";

  return (
    <Link href={AUTH_ROUTES.signIn} onClick={onNavigate} className={className}>
      Sign In
    </Link>
  );
}

function AuthenticatedState({ mobile = false, onNavigate }: NavbarAuthProps) {
  const { user } = useUser();
  const displayName = getUserDisplayName(user);

  if (mobile) {
    return (
      <div className="space-y-4 rounded-3xl border border-white/55 bg-white/55 p-4 shadow-[0_18px_40px_rgba(15,23,42,0.08)]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <UserButton
              userProfileMode="navigation"
              userProfileUrl={AUTH_ROUTES.userProfile}
            />
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#8f734f]">
                Account
              </p>
              <p className="text-sm font-medium text-slate-900">
                Welcome, {displayName}
              </p>
            </div>
          </div>
          <ChevronDownIcon className="h-5 w-5 text-slate-400" />
        </div>
        <SignOutButton redirectUrl={AUTH_ROUTES.home}>
          <button
            type="button"
            onClick={onNavigate}
            className="inline-flex h-11 w-full items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b49872] focus-visible:ring-offset-2"
          >
            Logout
          </button>
        </SignOutButton>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-full border border-white/60 bg-white/75 py-1.5 pl-1.5 pr-4 shadow-[0_12px_30px_rgba(15,23,42,0.08)] backdrop-blur">
      <UserButton
        userProfileMode="navigation"
        userProfileUrl={AUTH_ROUTES.userProfile}
      />
      <p className="text-sm font-medium text-slate-700">Welcome, {displayName}</p>
    </div>
  );
}

export function NavbarAuth(props: NavbarAuthProps) {
  return (
    <>
      <ClerkLoading>
        <LoadingState {...props} />
      </ClerkLoading>
      <ClerkLoaded>
        {props.mobile ? (
          <MobileAwareAuth {...props} />
        ) : (
          <DesktopAwareAuth {...props} />
        )}
      </ClerkLoaded>
    </>
  );
}

function DesktopAwareAuth(props: NavbarAuthProps) {
  const { isSignedIn } = useUser();

  if (!isSignedIn) {
    return <SignInLink {...props} />;
  }

  return <AuthenticatedState {...props} />;
}

function MobileAwareAuth(props: NavbarAuthProps) {
  const { isSignedIn } = useUser();

  if (!isSignedIn) {
    return <SignInLink {...props} mobile />;
  }

  return <AuthenticatedState {...props} mobile />;
}
