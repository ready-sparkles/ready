import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { docsArticles, getDocsArticle } from "../../../domain/docs/content";
import { DocsSidebar, DocsTopbar } from "../docs-chrome";

const DOCS_ROOT_LABEL = "Docs";
const DOCS_BREADCRUMB_SEPARATOR = "/";
const DOCS_BREADCRUMB_ARIA_LABEL = "Breadcrumb";
const DOCS_PRIVACY_BANNER_ARIA_LABEL = "Memory privacy";
const DOCS_FALLBACK_METADATA_TITLE = "Ready Docs";

type DocsArticlePageProps = {
  params: Promise<{ slug: string }>;
};

function getDocsSectionId(input: { articleSlug: string; title: string }): string {
  return `${input.articleSlug}-${input.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

export function generateStaticParams() {
  return docsArticles.map((article) => ({ slug: article.slug }));
}

export async function generateMetadata({ params }: DocsArticlePageProps): Promise<Metadata> {
  const { slug } = await params;
  const article = getDocsArticle(slug);

  if (!article) {
    return {
      title: DOCS_FALLBACK_METADATA_TITLE,
    };
  }

  return {
    title: `${article.title} - Ready Docs`,
    description: article.description,
  };
}

export default async function DocsArticlePage({ params }: DocsArticlePageProps) {
  const { slug } = await params;
  const article = getDocsArticle(slug);

  if (!article) {
    notFound();
  }

  return (
    <main className="docs-page">
      <DocsTopbar />

      <div className="docs-layout">
        <DocsSidebar activeSlug={article.slug} />

        <article className="docs-content">
          <nav className="docs-breadcrumb" aria-label={DOCS_BREADCRUMB_ARIA_LABEL}>
            <Link href="/docs">{DOCS_ROOT_LABEL}</Link>
            <span aria-hidden="true">{DOCS_BREADCRUMB_SEPARATOR}</span>
            <span>{article.category}</span>
          </nav>

          <header className="docs-article-header">
            <h1>{article.title}</h1>
            <p>{article.description}</p>
          </header>

          {article.notice ? (
            <aside className="docs-privacy-banner" aria-label={DOCS_PRIVACY_BANNER_ARIA_LABEL}>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
              </svg>
              <div>
                <strong>{article.notice.title}</strong>
                <p>{article.notice.description}</p>
              </div>
            </aside>
          ) : null}

          <div className="docs-article-body workspace-document-stack">
            {article.sections.map((section) => {
              const sectionId = getDocsSectionId({ articleSlug: article.slug, title: section.title });

              return (
                <section
                  className="docs-article-section workspace-flow-snapshot-notes is-static"
                  aria-labelledby={sectionId}
                  key={section.title}
                >
                  <h2 id={sectionId} className="workspace-flow-snapshot-note-heading docs-section-heading">
                    {section.title}
                  </h2>
                  {section.kind === "steps" ? (
                    <ol className="docs-article-lines docs-article-step-lines">
                      {section.items.map((item, index) => (
                        <li className="workspace-flow-snapshot-note-line" key={item}>
                          <span className="docs-step-marker" aria-hidden="true">
                            {index + 1}
                          </span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <ul className="docs-article-lines">
                      {section.items.map((item) => (
                        <li className="workspace-flow-snapshot-note-line" key={item}>
                          <span className="workspace-flow-summary-bullet" aria-hidden="true" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </article>
      </div>
    </main>
  );
}
