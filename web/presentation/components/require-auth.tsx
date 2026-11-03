"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { canAccessAuthenticatedRoute } from "../../domain/auth-route-access";

import { useAuth } from "./auth-provider";

export function RequireAuth({
  isGuestAllowed = false,
  children,
}: {
  isGuestAllowed?: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { isLoading, session } = useAuth();
  const isWorkspaceRoute = pathname === "/workspace" || pathname.startsWith("/workspace/");
  const canAccess = canAccessAuthenticatedRoute({ session, shouldAllowGuest: isGuestAllowed });

  useEffect(() => {
    if (!isLoading && !canAccess) {
      const queryString = typeof window !== "undefined" ? window.location.search.replace(/^\?/, "") : "";
      const callbackUrl = queryString !== "" ? `${pathname}?${queryString}` : pathname;
      router.push(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
    }
  }, [canAccess, isLoading, pathname, router]);

  // A background NextAuth refresh may set isLoading while the last verified
  // session remains usable. Keep authenticated surfaces mounted in that case
  // so persistent workspace navigation does not flash out of the DOM.
  if (!canAccess) {
    return (
      <main
        className={`auth-loading-shell${isWorkspaceRoute ? " is-workspace-auth-loading" : ""}`}
        aria-label="Checking session"
        role="status"
      />
    );
  }

  return <>{children}</>;
}
