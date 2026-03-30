import { UserProfile } from "@clerk/nextjs";
import { AUTH_ROUTES } from "@/lib/clerk";

export default function UserProfilePage() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16 sm:px-8">
      <section className="user-profile-shell w-full max-w-6xl rounded-[2rem] border border-white/55 bg-white/20 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_28px_90px_rgba(15,23,42,0.12)] backdrop-blur-2xl sm:p-8">
        <UserProfile path={AUTH_ROUTES.userProfile} routing="path" />
      </section>
    </main>
  );
}
