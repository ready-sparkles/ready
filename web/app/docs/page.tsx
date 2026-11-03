import type { Metadata } from "next";
import Link from "next/link";

import { docsCategories, getDocsArticles } from "../../domain/docs/content";

import { DocsSidebar, DocsTopbar } from "./docs-chrome";

const DOCS_HOME_TITLE = "Ready Docs";
const DOCS_HOME_TAGLINE = "Set up Ready, run meetings, and follow up.";

export const metadata: Metadata = {
  title: "Ready Docs",
  description: "Quick guides for Ready.",
};

export default function DocsPage() {
  return (
    <main className="docs-page">
      <DocsTopbar />

      <div className="docs-layout">
        <DocsSidebar />

        <div className="docs-content">
          <section className="docs-home-hero" aria-labelledby="docs-title">
            <h1 id="docs-title">{DOCS_HOME_TITLE}</h1>
            <p>{DOCS_HOME_TAGLINE}</p>
          </section>

          <div className="docs-home-body workspace-document-stack">
            {docsCategories.map((category) => (
              <section className="docs-home-section workspace-flow-snapshot-notes is-static" key={category.title}>
                <h2 className="workspace-flow-snapshot-note-heading">{category.title}</h2>
                <ul className="docs-article-lines">
                  {getDocsArticles(category.articles).map((article) => (
                    <li className="workspace-flow-snapshot-note-line" key={article.slug}>
                      <span className="workspace-flow-summary-bullet" aria-hidden="true" />
                      <Link href={`/docs/${article.slug}`}>{article.title}</Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
