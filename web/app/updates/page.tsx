import type { Metadata } from "next";
import Link from "next/link";

import { formatReleaseDate, releasePath, releases } from "../../domain/updates/releases";
import { PublicTopbar } from "../../presentation/components/public-topbar";

import { ReleaseAge } from "./release-age";
import { ReleaseBody } from "./release-body";
import { UpdatesFooter } from "./updates-footer";
import { UpdatesSearch } from "./updates-search";

import styles from "../../presentation/styles/updates/updates.module.css";

export const metadata: Metadata = {
  title: "Updates | Ready",
  description: "The latest features, improvements, and fixes in Ready. Better meetings, one update at a time.",
  alternates: { canonical: "https://ready.app/updates" },
  openGraph: {
    title: "Updates | Ready",
    description: "The latest updates to Ready.",
    url: "https://ready.app/updates",
  },
};

export default function UpdatesPage() {
  return (
    <main className={styles.page}>
      <PublicTopbar surface="light" />
      <a className={styles.skip} href="#updates">
        Skip to updates
      </a>
      <UpdatesSearch>
        {releases.map((release) => (
          <article
            key={release.slug}
            id={release.slug}
            className={styles.release}
            aria-labelledby={`${release.slug}-title`}
          >
            <aside className={styles.dateRail}>
              <div className={styles.dateMarker}>
                <Link href={releasePath(release)} aria-label={`Link to ${release.title}`}>
                  <span className={styles.dateDot} aria-hidden="true" />
                  <ReleaseAge date={release.date} fullDate={formatReleaseDate(release.date)} />
                </Link>
              </div>
            </aside>
            <div className={styles.content}>
              <h2 id={`${release.slug}-title`}>
                <Link href={releasePath(release)}>{release.title}</Link>
              </h2>
              <ReleaseBody release={release} />
            </div>
          </article>
        ))}
      </UpdatesSearch>
      <UpdatesFooter />
    </main>
  );
}
