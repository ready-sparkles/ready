import type { Release, ReleaseVisual } from "../../domain/updates/releases";

import { ProductCapture } from "./product-capture";
import { TypeSafeAnimation } from "./typesafe-animation";

import styles from "../../presentation/styles/updates/updates.module.css";

const MARKETPLACE_ARIA_LABEL = "Ready on Google Workspace Marketplace";
const TYPESAFE_VISUAL_HEADING = "Smarter name recognition";
const FIXES_SECTION_LABEL = "Fixes";
const IMPROVEMENTS_SECTION_LABEL = "Improvements";

const articleLinks: Record<string, string> = {
  TypeSafe: "https://typesafe.ai/team",
  "Parallel Web Systems": "https://parallel.ai",
  "Google Workspace Marketplace": "https://workspace.google.com/marketplace/app/ready/1011295591976",
};

function ReleaseText({ text }: { text: string }) {
  return text.split(/(\bTypeSafe\b|\bParallel Web Systems\b|\bGoogle Workspace Marketplace\b)/).map((part, index) => {
    const href = articleLinks[part];

    return href !== undefined ? (
      <a key={index} className={styles.inlineLink} href={href}>
        {part}
      </a>
    ) : (
      part
    );
  });
}

function ReleaseVisualCard({ visual }: { visual?: ReleaseVisual }) {
  if (visual === "marketplace") {
    const marketplaceHref = articleLinks["Google Workspace Marketplace"];

    return (
      <figure className={`${styles.marketplaceCard ?? ""} ${styles.darkNotesCapture ?? ""}`}>
        <a href={marketplaceHref} aria-label={MARKETPLACE_ARIA_LABEL}>
          <img
            src="/landing/google-workspace-marketplace.png"
            width="690"
            height="80"
            alt="Google Workspace Marketplace"
          />
        </a>
      </figure>
    );
  }
  if (visual === "typesafe") {
    return <TypeSafeAnimation />;
  }

  return visual !== undefined ? <ProductCapture kind={visual} /> : null;
}

export function ReleaseBody({ release }: { release: Release }) {
  return (
    <>
      <ReleaseVisualCard visual={release.visual} />
      {release.visualCaption !== undefined && release.visualCaption.length > 0 ? (
        <p className={styles.visualCaption}>{release.visualCaption}</p>
      ) : null}
      {release.visual === "typesafe" ? <h3 className={styles.visualHeading}>{TYPESAFE_VISUAL_HEADING}</h3> : null}
      <div className={styles.prose}>
        {release.paragraphs.map((paragraph) => (
          <p key={paragraph}>
            <ReleaseText text={paragraph} />
          </p>
        ))}
      </div>
      {release.sections?.map((section) => (
        <section key={section.title} className={styles.releaseSection}>
          <h3>{section.title}</h3>
          <ReleaseVisualCard visual={section.visual} />
          <div className={styles.prose}>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph}>
                <ReleaseText text={paragraph} />
              </p>
            ))}
          </div>
        </section>
      ))}
      <div className={styles.details}>
        {[
          { label: FIXES_SECTION_LABEL, items: release.fixes },
          { label: IMPROVEMENTS_SECTION_LABEL, items: release.improvements },
        ].map(({ label, items }) =>
          items.length !== 0 ? (
            <details key={label}>
              <summary>
                <span className={styles.sectionLabel}>
                  {label}
                  <span className={styles.count}>{items.length}</span>
                </span>
                <svg
                  className={styles.chevron}
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="m6 3.5 4.5 4.5L6 12.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </summary>
              <ul>
                {items.map((item) => (
                  <li key={`${item.area}:${item.text}`}>
                    <span>
                      <ReleaseText text={item.text} />
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null,
        )}
      </div>
    </>
  );
}
