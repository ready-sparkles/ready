"use client";

import Link from "next/link";
import { type KeyboardEvent, type ReactNode, type RefObject, useRef, useState } from "react";

import { formatReleaseDate, releasePath, releases } from "../../domain/updates/releases";

import styles from "../../presentation/styles/updates/updates.module.css";

const MAX_EXCERPT_PREFIX_LENGTH = 45;
const MIN_EXCERPT_LENGTH = 160;
const MAX_SEARCH_RESULTS = 5;
const UPDATES_TITLE = "Updates";
const UPDATES_DESCRIPTION = "Stay up to date with the latest product updates, new features, improvements, and fixes.";
const NO_UPDATES_FOUND = "No updates found.";
const normalizeSearch = (text: string) => text.normalize("NFKC").toLocaleLowerCase("en-US");
const searchableReleases = releases.map((release) => {
  const passages = [
    ...release.paragraphs,
    ...(release.sections ?? []).flatMap((section) => [section.title, ...section.paragraphs]),
    ...[...release.improvements, ...release.fixes].map((item) => item.text),
    release.title,
    release.category,
    formatReleaseDate(release.date),
  ].map((text) =>
    text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
      .normalize("NFKC"),
  );

  return { release, passages, text: normalizeSearch(passages.join(" ")) };
});

function matchingExcerpt({ passages, terms }: { passages: string[]; terms: string[] }) {
  // Prefer the passage matching the most search words; body text wins ties.
  const passage = passages.reduce(
    (best, text) => {
      const score = terms.filter((term) => normalizeSearch(text).includes(term)).length;

      return score > best.score ? { text, score } : best;
    },
    { text: passages[0] ?? "", score: 0 },
  ).text;
  const lower = normalizeSearch(passage);
  const matches = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const match = matches.length !== 0 ? Math.min(...matches) : 0;
  const startIndex = Math.max(0, match - MAX_EXCERPT_PREFIX_LENGTH);
  const start = startIndex > 0 ? passage.lastIndexOf(" ", startIndex) + 1 : 0;
  const end = Math.min(
    passage.length,
    Math.max(start + MIN_EXCERPT_LENGTH, match + Math.max(...terms.map((term) => term.length))),
  );
  const wordEnd = end < passage.length ? passage.indexOf(" ", end) : -1;
  const excerptEnd = wordEnd === -1 ? end : wordEnd;

  return `${start > 0 ? "…" : ""}${passage.slice(start, excerptEnd)}${excerptEnd < passage.length ? "…" : ""}`;
}

function handleSearchWrapperKeyDown(input: {
  event: React.KeyboardEvent<HTMLDivElement>;
  inputRef: React.RefObject<HTMLInputElement | null>;
  suggestionsMenuRef: RefObject<HTMLUListElement | null>;
  terms: string[];
  setIsSuggestionsOpen: (isOpen: boolean) => void;
}) {
  if (input.event.key === "Escape") {
    input.event.preventDefault();
    input.inputRef.current?.focus();
    input.setIsSuggestionsOpen(false);
  }
  if (input.event.key === "ArrowDown" || input.event.key === "ArrowUp") {
    const links = Array.from(input.suggestionsMenuRef.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []);
    if (links.length === 0) {
      if (input.terms.length !== 0) {
        input.setIsSuggestionsOpen(true);
      }

      return;
    }
    input.event.preventDefault();
    const current = links.findIndex((link) => link === document.activeElement);
    const next =
      input.event.key === "ArrowDown" ? (current + 1) % links.length : current <= 0 ? links.length - 1 : current - 1;
    links[next]?.focus();
  }
}

function UpdatesSearchSuggestions(input: {
  isShowingSuggestions: boolean;
  suggestions: typeof searchableReleases;
  suggestionsMenuRef: RefObject<HTMLUListElement | null>;
  terms: string[];
  setIsSuggestionsOpen: (isOpen: boolean) => void;
}) {
  if (!input.isShowingSuggestions) {
    return null;
  }

  return (
    <div className={styles.suggestions}>
      {input.suggestions.length !== 0 ? (
        <ul id="update-suggestions" ref={input.suggestionsMenuRef} aria-label="Search results">
          {input.suggestions.map(({ release, passages }) => (
            <li key={release.slug}>
              <Link href={releasePath(release)} onClick={() => input.setIsSuggestionsOpen(false)}>
                <span>{release.title}</span>
                <span className={styles.searchExcerpt}>{matchingExcerpt({ passages, terms: input.terms })}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p id="update-suggestions" className={styles.suggestionsEmpty}>
          {NO_UPDATES_FOUND}
        </p>
      )}
    </div>
  );
}

function UpdatesSearchHeader() {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const suggestionsMenu = useRef<HTMLUListElement>(null);
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const terms = normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
  const isShowingSuggestions = isSuggestionsOpen && terms.length !== 0;
  const suggestions = searchableReleases
    .filter((article) => terms.every((term) => article.text.includes(term)))
    .slice(0, MAX_SEARCH_RESULTS);

  return (
    <header className={styles.header}>
      <div>
        <h1 className={styles.title} role="heading" aria-level={1}>
          {UPDATES_TITLE}
        </h1>
        <p className={styles.description}>{UPDATES_DESCRIPTION}</p>
      </div>
      <div
        className={styles.searchWrapper}
        role="search"
        aria-label="Updates"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setIsSuggestionsOpen(false);
          }
        }}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          handleSearchWrapperKeyDown({
            event,
            inputRef: input,
            suggestionsMenuRef: suggestionsMenu,
            terms,
            setIsSuggestionsOpen,
          });
        }}
      >
        <div className={`workspace-task-search-control ${styles.search ?? ""}`}>
          <svg aria-hidden="true" viewBox="0 0 24 24" className="workspace-task-topbar-search-icon" fill="none">
            <path
              d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <input
            ref={input}
            type="search"
            className="workspace-task-search-input"
            value={query}
            placeholder="Search"
            aria-label="Search updates"
            aria-controls={isShowingSuggestions ? "update-suggestions" : undefined}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setIsSuggestionsOpen(true);
            }}
          />
          {query.length !== 0 ? (
            <button
              type="button"
              className="workspace-task-search-clear"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                setIsSuggestionsOpen(false);
                input.current?.focus();
              }}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="workspace-task-search-clear-icon">
                <circle cx="12" cy="12" r="10" fill="currentColor" />
                <path d="m8.75 8.75 6.5 6.5M15.25 8.75l-6.5 6.5" stroke="white" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}
        </div>
        <UpdatesSearchSuggestions
          isShowingSuggestions={isShowingSuggestions}
          suggestions={suggestions}
          suggestionsMenuRef={suggestionsMenu}
          terms={terms}
          setIsSuggestionsOpen={setIsSuggestionsOpen}
        />
      </div>
    </header>
  );
}

export function UpdatesSearch({ children }: { children: ReactNode }) {
  return (
    <>
      <UpdatesSearchHeader />
      <div id="updates" className={styles.feed}>
        {children}
      </div>
    </>
  );
}
