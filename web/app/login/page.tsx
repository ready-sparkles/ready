import { Suspense } from "react";

import { LoginForm } from "../../presentation/components/login-form";

export default function LoginPage() {
  return (
    <main className="login-page">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
