import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { formatReleaseDate, releasePath, releases } from "../../../domain/updates/releases";
import { PublicTopbar } from "../../../presentation/components/public-topbar";
import { ReleaseBody } from "../release-body";
import { UpdatesFooter } from "../updates-footer";

import styles from "../../../presentation/styles/updates/updates.module.css";

const UPDATES_NAV_LABEL = "Updates";
const SKIP_TO_UPDATE_LABEL = "Skip to update";

type Props = { params: Promise<{ slug: string }> };
const findRelease = (slug: string) => releases.find((release) => `${release.date}-${release.slug}` === slug);

export function generateStaticParams() {
  return releases.map((release) => ({ slug: `${release.date}-${release.slug}` }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const release = findRelease((await params).slug);
  if (!release) {
    notFound();
  }
  const url = `https://ready.app${releasePath(release)}`;

  return {
    title: `${release.title} | Ready Updates`,
    description: release.paragraphs[0],
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      title: release.title,
      description: release.paragraphs[0],
      url,
      publishedTime: release.date,
    },
  };
}

export default async function UpdateArticlePage({ params }: Props) {
  const release = findRelease((await params).slug);
  if (!release) {
    notFound();
  }

  const releaseClassName = `${styles.release ?? ""} ${styles.standaloneRelease ?? ""}`.trim();

  return (
    <main className={styles.page ?? ""}>
      <PublicTopbar surface="light" />
      <a className={styles.skip} href="#article">
        {SKIP_TO_UPDATE_LABEL}
      </a>
      <div className={styles.articleShell}>
        <div className={styles.articleMeta}>
          <Link href="/updates" className={styles.backLink}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="m10 3.5-4.5 4.5 4.5 4.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {UPDATES_NAV_LABEL}
          </Link>
          <time className={styles.articleDate} dateTime={release.date}>
            {formatReleaseDate(release.date)}
          </time>
        </div>
        <article id="article" className={releaseClassName} aria-labelledby="article-title">
          <div className={styles.content}>
            <h1 id="article-title" className={styles.articleTitle}>
              {release.title}
            </h1>
            <ReleaseBody release={release} />
          </div>
        </article>
      </div>
      <UpdatesFooter />
    </main>
  );
}
