import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginForm } from "../../presentation/components/login-form";

export const metadata: Metadata = {
  title: "Sign up | Ready",
  description: "Create your Ready account.",
};

export default function SignupPage() {
  return (
    <main className="login-page">
      <Suspense fallback={null}>
        <LoginForm variant="signup" />
      </Suspense>
    </main>
  );
}
