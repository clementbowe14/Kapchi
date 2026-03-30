import { SignIn } from "@clerk/nextjs";
import { AuthShell } from "@/components/AuthShell";
import { AUTH_ROUTES } from "@/lib/clerk";

export default function SignInPage() {
  return (
    <AuthShell>
      <SignIn
        path={AUTH_ROUTES.signIn}
        routing="path"
        signUpUrl={AUTH_ROUTES.signUp}
        fallbackRedirectUrl={AUTH_ROUTES.home}
      />
    </AuthShell>
  );
}
