import { SignUp } from "@clerk/nextjs";
import { AuthShell } from "@/components/AuthShell";
import { AUTH_ROUTES } from "@/lib/clerk";

export default function SignUpPage() {
  return (
    <AuthShell>
      <SignUp
        path={AUTH_ROUTES.signUp}
        routing="path"
        signInUrl={AUTH_ROUTES.signIn}
        fallbackRedirectUrl={AUTH_ROUTES.home}
      />
    </AuthShell>
  );
}
