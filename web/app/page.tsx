import type { Viewport } from "next";
import { redirect } from "next/navigation";

import { auth } from "../auth";
import { shouldRedirectHomeToWorkspace } from "../domain/home-routing";
import { DEFAULT_LOGIN_CALLBACK_URL } from "../domain/login-callback";
import { PublicHomePage } from "../presentation/components/public-home-page";

export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  themeColor: "#05070c",
};

export default async function HomePage({ searchParams }: { searchParams: Promise<{ view?: string | string[] }> }) {
  const { view } = await searchParams;
  const session = await auth();

  if (shouldRedirectHomeToWorkspace({ session, showPublicHome: view === "home" })) {
    redirect(DEFAULT_LOGIN_CALLBACK_URL);
  }

  return <PublicHomePage />;
}
