import type { Metadata } from "next";
import Link from "next/link";

import { PublicTopbar } from "../../presentation/components/public-topbar";

export const metadata: Metadata = {
  title: "About Ready",
  description: "Why we’re building Ready, how the source is licensed, and the people behind it.",
};

const ABOUT_TITLE = "About Ready";
const CONTENTS_LABEL = "Contents";
const PROFILE_LABEL = "x.com/readymeeting";
const EMAIL_LABEL = "hello@ready.app";
const PRIVACY_LABEL = "Privacy";
const TERMS_LABEL = "Terms";
const COPYRIGHT_MARK = "© ";
const COPYRIGHT_NAME = " Ready";
const INTER_COMMA = ",";

const ABOUT_SECTIONS = [
  {
    id: "source",
    title: "Source",
    paragraphs: [
      "Ready is source-available under the Business Source License 1.1. Devin Ersoy and Sam Zetterberg license the source, so you can inspect how it works and how it handles your meeting data.",
      "You may copy, modify, and use it for non-production purposes. On November 3, 2030, this release is licensed under GPL-2.0-or-later.",
    ],
  },
  {
    id: "company",
    title: "Company",
    paragraphs: [
      "Ready Sparkles, Inc. was incorporated in September 2026. The company operates the hosted service.",
      "If you have questions or feedback, get in touch by email or on X.",
    ],
  },
];

function renderInterCommas(text: string) {
  return text.split(",").flatMap((part, index) =>
    index === 0
      ? [part]
      : [
          <span key={`comma-${index}`} className="public-geist-comma">
            {INTER_COMMA}
          </span>,
          part,
        ],
  );
}

export default function AboutPage() {
  return (
    <main className="about-page" role="main">
      <PublicTopbar surface="light" />

      <article className="about-article" aria-labelledby="about-title">
        <header className="about-article-header">
          <h1 id="about-title">{ABOUT_TITLE}</h1>
        </header>

        <div className="about-layout">
          <nav className="about-contents" aria-label={CONTENTS_LABEL}>
            <p>{CONTENTS_LABEL}</p>
            {ABOUT_SECTIONS.map((section) => (
              <a key={section.id} href={`#${section.id}`}>
                {section.title}
              </a>
            ))}
          </nav>
          <div className="about-story-column">
            {ABOUT_SECTIONS.map((section) => (
              <section
                key={section.id}
                id={section.id}
                className="about-section"
                aria-labelledby={`${section.id}-title`}
              >
                <h2 id={`${section.id}-title`}>{section.title}</h2>
                <div className="about-story-copy">
                  {section.paragraphs.map((paragraph) => (
                    <p key={paragraph}>{renderInterCommas(paragraph)}</p>
                  ))}
                </div>
              </section>
            ))}
            <div className="about-signoff">
              <a className="about-profile-link" href="mailto:hello@ready.app">
                {EMAIL_LABEL}
              </a>
              <a className="about-profile-link" href="https://x.com/readymeeting" target="_blank" rel="noreferrer">
                {PROFILE_LABEL}
              </a>
            </div>
          </div>
        </div>
      </article>

      <footer className="public-home-footer about-footer" role="contentinfo">
        <span className="public-home-footer-copyright">
          {COPYRIGHT_MARK}
          {new Date().getFullYear()}
          {COPYRIGHT_NAME}
        </span>
        <Link href="/privacy">{PRIVACY_LABEL}</Link>
        <Link href="/terms">{TERMS_LABEL}</Link>
      </footer>
    </main>
  );
}
