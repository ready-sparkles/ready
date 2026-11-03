"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { docsCategories, getDocsArticles } from "../../domain/docs/content";
import { ReadyLogo } from "../../presentation/components/ready-logo";

const SIGN_IN_LABEL = "Sign in";

type DocsSidebarProps = {
  activeSlug?: string;
};

function DocsSidebarChevron() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="docs-sidebar-chevron" fill="none">
      <path
        d="M6 3.75 10.25 8 6 12.25"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DocsTopbar() {
  return (
    <header className="docs-topbar">
      <Link href="/" className="docs-brand" aria-label="Ready home">
        <span className="meeting-join-logo docs-topbar-logo">
          <ReadyLogo />
        </span>
      </Link>
      <nav className="docs-topbar-links public-home-nav-links is-custom" role="navigation" aria-label="Docs links">
        <Link href="/login" className="public-home-nav-login">
          {SIGN_IN_LABEL}
        </Link>
      </nav>
    </header>
  );
}

export function DocsSidebar({ activeSlug }: DocsSidebarProps) {
  const activeCategoryTitle = useMemo(() => {
    if (activeSlug === undefined || activeSlug === "") {
      return null;
    }

    return docsCategories.find((category) => category.articles.includes(activeSlug))?.title ?? null;
  }, [activeSlug]);
  const [openCategoryTitle, setOpenCategoryTitle] = useState<string | null>(activeCategoryTitle);

  useEffect(() => {
    if (activeCategoryTitle !== null && activeCategoryTitle !== "") {
      setOpenCategoryTitle(activeCategoryTitle);
    }
  }, [activeCategoryTitle]);

  return (
    <aside className="docs-sidebar" role="complementary" aria-label="Documentation pages">
      <nav className="docs-sidebar-nav" role="navigation">
        {docsCategories.map((category) => {
          const isOpen = openCategoryTitle === category.title;
          const categoryArticles = getDocsArticles(category.articles);
          const onlyArticle = categoryArticles.length === 1 ? categoryArticles[0] : null;

          if (onlyArticle) {
            return (
              <Link
                className="docs-sidebar-section-trigger"
                href={`/docs/${onlyArticle.slug}`}
                key={category.title}
                aria-current={activeSlug === onlyArticle.slug ? "page" : undefined}
              >
                {onlyArticle.navTitle ?? onlyArticle.title}
              </Link>
            );
          }

          return (
            <section className="docs-sidebar-section" key={category.title}>
              <button
                className="docs-sidebar-section-trigger"
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpenCategoryTitle(isOpen ? null : category.title)}
              >
                <span>{category.title}</span>
                <DocsSidebarChevron />
              </button>

              <div className="docs-sidebar-links" hidden={!isOpen}>
                {categoryArticles.map((article) => (
                  <Link
                    href={`/docs/${article.slug}`}
                    key={article.slug}
                    aria-current={activeSlug === article.slug ? "page" : undefined}
                  >
                    {article.navTitle ?? article.title}
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
        <div className="docs-sidebar-legal">
          {[
            { title: "Privacy", href: "https://ready.app/privacy" },
            { title: "Terms", href: "https://ready.app/terms" },
          ].map(({ title, href }) => (
            <a
              className="docs-sidebar-section-trigger docs-sidebar-external"
              href={href}
              key={href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${title} (opens in a new tab)`}
            >
              <span>{title}</span>
              <svg aria-hidden="true" viewBox="0 0 16 16" className="docs-sidebar-chevron" fill="none">
                <path
                  d="M4 12 12 4M4 4h8v8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
          ))}
        </div>
      </nav>
    </aside>
  );
}
