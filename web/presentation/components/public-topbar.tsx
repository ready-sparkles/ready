"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type Dispatch, type ReactNode, type RefObject, type SetStateAction, useEffect, useRef, useState } from "react";

import { PublicReadyLogo } from "./public-ready-logo";

const NAV_SCROLL_THRESHOLD_PX = 2;
const DESKTOP_NAV_BREAKPOINT_PX = 760;

const COPY_PUBLIC_TOPBAR_PRICING = "Pricing";
const COPY_PUBLIC_TOPBAR_SIGN_IN = "Sign in";
const COPY_PUBLIC_TOPBAR_START_TRIAL = "Start a trial";
const COPY_PUBLIC_TOPBAR_RESOURCES = "Resources";
const COPY_PUBLIC_TOPBAR_ABOUT = "About";
const COPY_PUBLIC_TOPBAR_UPDATES = "Updates";
const COPY_PUBLIC_TOPBAR_GITHUB = "GitHub";

const PUBLIC_RESOURCE_LINKS: readonly (readonly [string, string])[] = [
  [COPY_PUBLIC_TOPBAR_ABOUT, "/about"],
  [COPY_PUBLIC_TOPBAR_UPDATES, "/updates"],
];

function isPublicTopbarActivePath(input: { pathname: string; href: string }): boolean {
  return input.pathname === input.href || input.pathname.startsWith(`${input.href}/`);
}

function buildPublicTopbarClassName(input: {
  hasScrolled: boolean;
  surface: "auto" | "light";
  isLightSurface: boolean;
  className: string;
}): string {
  return [
    "public-home-nav",
    input.hasScrolled ? "is-scrolled" : "",
    input.surface === "light" || input.isLightSurface ? "is-light-surface" : "",
    input.className,
  ]
    .filter(Boolean)
    .join(" ");
}

function usePublicTopbarSurfaceState(input: { navRef: RefObject<HTMLDivElement | null> }) {
  const [hasScrolled, setHasScrolled] = useState(false);
  const [isLightSurface, setIsLightSurface] = useState(false);

  useEffect(() => {
    const updateTopbarState = () => {
      const hasScrolledNext = window.scrollY > NAV_SCROLL_THRESHOLD_PX;
      const nav = input.navRef.current;
      const darkSurface = nav?.closest<HTMLElement>("[data-public-nav-dark-surface]") ?? null;
      const navRect = nav?.getBoundingClientRect();
      const isOverExplicitLightSurface = Boolean(
        navRect &&
        Array.from(document.querySelectorAll<HTMLElement>("[data-public-nav-light-surface]")).some((lightSurface) => {
          const surfaceRect = lightSurface.getBoundingClientRect();

          return surfaceRect.top < navRect.bottom && surfaceRect.bottom > navRect.top;
        }),
      );
      const isLightSurfaceNext =
        isOverExplicitLightSurface ||
        Boolean(navRect && darkSurface && darkSurface.getBoundingClientRect().bottom <= navRect.bottom);

      setHasScrolled((hasScrolledNow) => (hasScrolledNow === hasScrolledNext ? hasScrolledNow : hasScrolledNext));
      setIsLightSurface((isLightSurfaceNow) =>
        isLightSurfaceNow === isLightSurfaceNext ? isLightSurfaceNow : isLightSurfaceNext,
      );
    };

    updateTopbarState();
    window.addEventListener("scroll", updateTopbarState, { passive: true });
    window.addEventListener("resize", updateTopbarState);

    return () => {
      window.removeEventListener("scroll", updateTopbarState);
      window.removeEventListener("resize", updateTopbarState);
    };
  }, [input.navRef]);

  return { hasScrolled, isLightSurface };
}

function usePublicTopbarMobileMenuLock(input: {
  isMenuOpen: boolean;
  navRef: RefObject<HTMLDivElement | null>;
  setIsMenuOpen: Dispatch<SetStateAction<boolean>>;
}) {
  useEffect(() => {
    if (!input.isMenuOpen) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        input.setIsMenuOpen(false);
        input.navRef.current?.querySelector<HTMLButtonElement>(".public-home-nav-menu-button")?.focus();
      }
    };
    const onResize = () => {
      if (window.innerWidth > DESKTOP_NAV_BREAKPOINT_PX) {
        input.setIsMenuOpen(false);
      }
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("resize", onResize);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [input.isMenuOpen, input.navRef, input.setIsMenuOpen]);
}

function ResourcesMenu({ onNavigate }: { onNavigate?: () => void }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const openedByHover = useRef(false);
  const pathname = usePathname();
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !(menu.current?.contains(event.target) ?? false) && menu.current) {
        menu.current.open = false;
        openedByHover.current = false;
      }
    };
    document.addEventListener("pointerdown", closeOutside);

    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  return (
    <details
      ref={menu}
      className="public-resources"
      onPointerEnter={(event) => {
        const details = event.currentTarget;
        if (event.pointerType === "mouse" && !details.open) {
          openedByHover.current = true;
          details.open = true;
        }
      }}
      onPointerLeave={(event) => {
        openedByHover.current = false;
        const details = event.currentTarget;
        if (event.pointerType === "mouse" && !details.contains(document.activeElement)) {
          details.open = false;
        }
      }}
      onBlur={(event) => {
        const details = event.currentTarget;
        if (!details.contains(event.relatedTarget)) {
          details.open = false;
          openedByHover.current = false;
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          openedByHover.current = false;
          const details = event.currentTarget;
          details.open = false;
          details.querySelector("summary")?.focus();
          event.stopPropagation();
        }
      }}
    >
      <summary
        onClick={(event) => {
          // The first mouse click confirms the menu opened by hover. Let later
          // clicks, touch, and keyboard activation keep the native toggle behavior.
          if (event.detail > 0 && openedByHover.current) {
            event.preventDefault();
          }
          openedByHover.current = false;
        }}
      >
        {COPY_PUBLIC_TOPBAR_RESOURCES}
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="public-resources-bridge">
        <div className="public-resources-links">
          {PUBLIC_RESOURCE_LINKS.map(([label, href]) => (
            <Link
              key={href}
              href={href}
              aria-current={isPublicTopbarActivePath({ pathname, href }) ? "page" : undefined}
              onClick={() => {
                if (menu.current) {
                  menu.current.open = false;
                }
                openedByHover.current = false;
                onNavigate?.();
              }}
            >
              {label}
            </Link>
          ))}
        </div>
      </div>
    </details>
  );
}

function GitHubPlaceholder() {
  return (
    <span className="public-home-nav-github" role="link" aria-disabled="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 .297C5.37.297 0 5.67 0 12.297c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.418-1.305.762-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.31.469-2.381 1.236-3.221-.124-.303-.536-1.524.117-3.176 0 0 1.008-.322 3.301 1.23a11.52 11.52 0 0 1 3.003-.404c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.655 1.652.243 2.873.12 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.015 2.898-.015 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
      </svg>
      {COPY_PUBLIC_TOPBAR_GITHUB}
    </span>
  );
}

function PublicTopbarDefaultNav(input: {
  pathname: string;
  isMenuOpen: boolean;
  onCloseMenu: () => void;
  onToggleMenu: () => void;
}) {
  return (
    <>
      <div className="public-home-nav-links">
        <GitHubPlaceholder />
        <ResourcesMenu />
        <Link
          href="/pricing"
          aria-current={isPublicTopbarActivePath({ pathname: input.pathname, href: "/pricing" }) ? "page" : undefined}
        >
          {COPY_PUBLIC_TOPBAR_PRICING}
        </Link>
        <Link className="public-home-nav-login" href="/login">
          {COPY_PUBLIC_TOPBAR_SIGN_IN}
        </Link>
        <Link className="public-home-nav-request" href="/signup">
          {COPY_PUBLIC_TOPBAR_START_TRIAL}
        </Link>
      </div>
      <div className="public-home-mobile-actions">
        <Link className="public-home-mobile-request" href="/signup" onClick={input.onCloseMenu}>
          {COPY_PUBLIC_TOPBAR_START_TRIAL}
        </Link>
        <button
          type="button"
          className={`public-home-nav-menu-button${input.isMenuOpen ? " is-open" : ""}`}
          aria-label={input.isMenuOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={input.isMenuOpen}
          aria-controls="public-home-mobile-menu"
          onClick={input.onToggleMenu}
        >
          <span className="public-home-nav-menu-icon" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </button>
      </div>
    </>
  );
}

function PublicTopbarMobileMenu(input: { pathname: string; onCloseMenu: () => void }) {
  return (
    <div id="public-home-mobile-menu" className="public-home-mobile-menu">
      <Link href="/login" onClick={input.onCloseMenu}>
        {COPY_PUBLIC_TOPBAR_SIGN_IN}
      </Link>
      <Link
        href="/pricing"
        aria-current={isPublicTopbarActivePath({ pathname: input.pathname, href: "/pricing" }) ? "page" : undefined}
        onClick={input.onCloseMenu}
      >
        {COPY_PUBLIC_TOPBAR_PRICING}
      </Link>
      <GitHubPlaceholder />
      <section className="public-mobile-resources" aria-labelledby="public-mobile-resources-title">
        <h2 id="public-mobile-resources-title">{COPY_PUBLIC_TOPBAR_RESOURCES}</h2>
        <Link
          href="/about"
          aria-current={isPublicTopbarActivePath({ pathname: input.pathname, href: "/about" }) ? "page" : undefined}
          onClick={input.onCloseMenu}
        >
          {COPY_PUBLIC_TOPBAR_ABOUT}
        </Link>
        <Link
          href="/updates"
          aria-current={isPublicTopbarActivePath({ pathname: input.pathname, href: "/updates" }) ? "page" : undefined}
          onClick={input.onCloseMenu}
        >
          {COPY_PUBLIC_TOPBAR_UPDATES}
        </Link>
      </section>
    </div>
  );
}

export function PublicTopbar({
  className = "",
  actions,
  surface = "auto",
  /** @external public topbar prop */
  ariaHidden,
}: {
  className?: string;
  actions?: ReactNode;
  surface?: "auto" | "light";
  /** @external public topbar prop */
  ariaHidden?: boolean;
}) {
  const pathname = usePathname();
  const navRef = useRef<HTMLDivElement | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { hasScrolled, isLightSurface } = usePublicTopbarSurfaceState({ navRef });
  const hasCustomActions = actions !== undefined && actions !== null;
  const closeMenu = () => setIsMenuOpen(false);

  usePublicTopbarMobileMenuLock({
    isMenuOpen,
    navRef,
    setIsMenuOpen,
  });

  const navClassName = buildPublicTopbarClassName({
    hasScrolled,
    surface,
    isLightSurface,
    className,
  });
  const toggleMenu = () => setIsMenuOpen((isCurrentlyOpen) => !isCurrentlyOpen);

  return (
    <nav
      ref={navRef}
      className={navClassName}
      aria-label="Ready navigation"
      aria-hidden={ariaHidden}
      inert={ariaHidden}
    >
      <Link className="public-home-brand" href="/?view=home" aria-label="Ready home" onClick={closeMenu}>
        <PublicReadyLogo className="public-home-brand-lockup" />
      </Link>
      {hasCustomActions ? (
        <div className="public-home-nav-links is-custom">{actions}</div>
      ) : (
        <PublicTopbarDefaultNav
          pathname={pathname}
          isMenuOpen={isMenuOpen}
          onCloseMenu={closeMenu}
          onToggleMenu={toggleMenu}
        />
      )}
      {!hasCustomActions && isMenuOpen ? <PublicTopbarMobileMenu pathname={pathname} onCloseMenu={closeMenu} /> : null}
    </nav>
  );
}
