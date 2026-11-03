"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { getOAuthSignInHref } from "../../composition/auth-client";
import { DEFAULT_LOGIN_CALLBACK_URL } from "../../domain/login-callback";

import { GoogleIcon, MicrosoftIcon } from "./auth-provider-icons";
import { DebugHomeMeetingShowcase } from "./debug-home-meeting-showcase";
import { PublicFaqSection } from "./public-faq-section";
import { PublicTopbar } from "./public-topbar";
import { ScrollReveal } from "./scroll-reveal";

const DEFAULT_REVEAL_THRESHOLD = 0.3;
const CLOSING_REVEAL_THRESHOLD = 0.5;

const COPY_FAQ_GOOGLE_WORKSPACE_MARKETPLACE_LINK_TEXT = "Google Workspace Marketplace";
const COPY_HERO_GREETING = "Live meeting intelligence";
const COPY_HERO_SUBTITLE = "A source-available video calling platform that keeps up with your conversations.";
const COPY_HERO_INTRO =
  "Ready keeps track so you don’t have to. Mention someone, and their background comes up. Decisions and next steps take shape as you talk.";
const COPY_HERO_CTA_GET_STARTED = "Get started";
const COPY_HERO_INSTANT_MEETING_PREFIX = "Or start a meeting instantly at ready.new ";
const COPY_EXTERNAL_LINK_ARROW = "↗";
const COPY_CLOSING_HEADLINE = "Ready when you are.";
const COPY_CONTINUE_WITH_GOOGLE = "Continue with Google";
const COPY_CONTINUE_WITH_MICROSOFT = "Continue with Microsoft";
const COPY_FOOTER_COPYRIGHT_PREFIX = "© ";
const COPY_FOOTER_COPYRIGHT_SUFFIX = " Ready";
const COPY_FOOTER_UPDATES = "Updates";
const COPY_FOOTER_PRIVACY = "Privacy";
const COPY_FOOTER_TERMS = "Terms";
function useRevealOnScroll<T extends HTMLElement>(threshold = DEFAULT_REVEAL_THRESHOLD) {
  const ref = useRef<T | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setIsVisible(true);

      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            observer.disconnect();
          }
        });
      },
      { threshold },
    );
    observer.observe(node);

    return () => observer.disconnect();
  }, [threshold]);

  return { ref, isVisible };
}

const FAQ_ITEMS = [
  {
    question: "What is Ready?",
    answer:
      "Ready is a video meeting space that keeps track of decisions, open questions, and tasks as you talk. Mention someone to bring up relevant context about them, right in the call. When you’re on your own, talk to your AI assistant to think things through.",
  },
  {
    question: "How do I start a meeting?",
    answer:
      "Type ready.new in your browser. Ready opens an instant meeting and takes you through sign-in if needed. To schedule ahead, install the Ready add-on for Google Calendar from the Google Workspace Marketplace, and add a Ready meeting to any event.",
    link: {
      text: COPY_FAQ_GOOGLE_WORKSPACE_MARKETPLACE_LINK_TEXT,
      href: "https://workspace.google.com/marketplace/app/ready/1011295591976",
    },
  },
  {
    question: "Can agents use my shared screen?",
    answer: "Yes. While you’re sharing, agents can use what’s visible to give more helpful answers.",
  },
  {
    question: "Is my data used for AI training?",
    answer:
      "No. Ready doesn’t use your data to train AI models. Your meetings stay private to the people you share them with.",
  },
  {
    question: "What happens after the call?",
    answer:
      "Ready turns the conversation into notes, decisions, and tasks, so follow-through is already underway when the meeting ends.",
  },
];

export function PublicHomePage() {
  const closing = useRevealOnScroll<HTMLDivElement>(CLOSING_REVEAL_THRESHOLD);

  return (
    <main className="public-home-page" aria-label="Ready">
      <div className="public-home-dark-intro" data-public-nav-dark-surface>
        <div className="public-home-page-nav-shell">
          <PublicTopbar className="public-home-page-nav" />
        </div>
        <section className="public-home-hero">
          <div className="public-home-copy">
            <h1 className="public-home-hero-enter public-home-title-enter">
              <span>{COPY_HERO_GREETING}</span>
            </h1>
            <p className="public-home-subtitle public-home-hero-enter public-home-title-enter">{COPY_HERO_SUBTITLE}</p>
          </div>

          <div className="public-home-hero-media public-home-hero-enter">
            <DebugHomeMeetingShowcase />
          </div>

          <div className="public-home-hero-cta">
            <ScrollReveal as="p" className="public-home-intro-copy">
              {COPY_HERO_INTRO}
            </ScrollReveal>
            <ScrollReveal delayMs={140}>
              <Link className="public-home-hero-cta-button" href="/signup">
                {COPY_HERO_CTA_GET_STARTED}
              </Link>
            </ScrollReveal>
            <ScrollReveal delayMs={220}>
              <a className="public-home-hero-cta-note" href="https://ready.new">
                {COPY_HERO_INSTANT_MEETING_PREFIX}
                <span aria-hidden="true">{COPY_EXTERNAL_LINK_ARROW}</span>
              </a>
            </ScrollReveal>
          </div>
        </section>
      </div>

      <PublicFaqSection id="public-home-faq" items={FAQ_ITEMS} initiallyOpen={2} />

      <section
        ref={closing.ref}
        className={`public-home-closing${closing.isVisible ? " is-visible" : ""}`}
        aria-label="Get started"
        data-public-nav-light-surface
      >
        <h2>
          <span>{COPY_CLOSING_HEADLINE}</span>
        </h2>
        <div className="public-home-closing-actions">
          <a className="login-provider-button" href={getOAuthSignInHref("google", DEFAULT_LOGIN_CALLBACK_URL)}>
            <span className="login-provider-icon" aria-hidden="true">
              <GoogleIcon />
            </span>
            <span>{COPY_CONTINUE_WITH_GOOGLE}</span>
          </a>
          <a
            className="login-provider-button"
            href={getOAuthSignInHref("microsoft-entra-id", DEFAULT_LOGIN_CALLBACK_URL)}
          >
            <span className="login-provider-icon" aria-hidden="true">
              <MicrosoftIcon />
            </span>
            <span>{COPY_CONTINUE_WITH_MICROSOFT}</span>
          </a>
        </div>
      </section>

      <footer className="public-home-footer" data-public-nav-light-surface>
        <span className="public-home-footer-copyright">
          {COPY_FOOTER_COPYRIGHT_PREFIX}
          {new Date().getFullYear()}
          {COPY_FOOTER_COPYRIGHT_SUFFIX}
        </span>
        <Link href="/updates">{COPY_FOOTER_UPDATES}</Link>
        <Link href="/privacy">{COPY_FOOTER_PRIVACY}</Link>
        <Link href="/terms">{COPY_FOOTER_TERMS}</Link>
      </footer>
    </main>
  );
}
