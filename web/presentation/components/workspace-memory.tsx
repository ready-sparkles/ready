"use client";
import {
  compareRelationshipMemories,
  type MemoryListPage,
  type MemoryPeoplePage,
  type MemoryPerson,
  memoryPersonMatchesFilters,
  type MemoryPreferences,
  type MemoryStatus,
  normalizeMemoryCategory,
  type RelationshipMemory,
} from "@readymeet/shared";
import {
  type InfiniteData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  getApiErrorMessage,
  getMemoryEvidence,
  getMemoryPerson,
  getMemoryStatus,
  saveMemorySettings,
  updateMemories,
} from "../../composition/api";
import { broadcastMemoryForget, removeForgottenMemories } from "../../composition/memory-cache-updates";
import { memoryListOptions, memoryPeopleOptions } from "../../composition/memory-query-options";
import { useMemoryPeopleScrollAnchor } from "../../composition/use-memory-people-scroll-anchor";
import { canShowMemoryNavigation } from "../../domain/memory-navigation";
import { memoryFilterScopeSchema } from "../../domain/schemas/workspace-memory";
import { useTrialOffer } from "../lib/use-trial-offer";

import { MemoryCardBrowser, type MemoryCardBrowserHandle } from "./memory-stack/memory-card-browser";
import { type MemoryDisplayMode, MemoryLayoutToggle } from "./memory-stack/memory-layout-toggle";
import { MemoryVirtualList, type MemoryVirtualListHandle } from "./memory-stack/memory-virtual-list";
import { useMemoryArrivals } from "./memory-stack/use-memory-arrivals";
import { useAuth } from "./auth-provider";
import { MeetingProUpgradeCard } from "./meeting-pro-upgrade-card";
import {
  type BrowserFilters,
  contactAgeInDays,
  memoryAge,
  MemoryBrowserToolbar,
  MemoryGroup,
  MemoryIcon,
  MemoryTimelineArrow,
  moveRowFocus,
  PersonInitials,
} from "./memory-browser-controls";
import { MemoryLoadMore } from "./memory-load-more";
import { MemoryPersonText } from "./memory-person-text";
import { useMemoryFailureToast } from "./use-memory-failure-toast";
import { ArchiveTrayIcon, CalendarChevronIcon, MemoryAllNavIcon, PeopleNavIcon } from "./workspace-nav-icons";
import { WorkspaceShell } from "./workspace-shell";

// Status and person details remain short-lived in-memory queries.
const MS_PER_MINUTE = 60_000;
const MEMORY_BROWSER_CACHE_MINUTES = 5;
const MEMORY_BROWSER_CACHE_TIME_MS = MEMORY_BROWSER_CACHE_MINUTES * MS_PER_MINUTE;
const MEMORY_STATUS_REFETCH_INTERVAL_MS = 10_000;
const MEMORY_QUERY_REFETCH_INTERVAL_MS = 15_000;

const MESSAGE_MEMORY_SETTINGS_LOAD_FAILED = "Could not load settings.";
const MESSAGE_MEMORY_SETTINGS_TRY_AGAIN = "Try again";
const MESSAGE_MEMORY_SETTINGS_UNAVAILABLE = "Memory is not available in this environment yet.";
const MESSAGE_MEMORY_SETTINGS_SENSITIVE_LABEL = "Include sensitive topics in memory";
const MESSAGE_MEMORY_SETTINGS_SENSITIVE_DESCRIPTION =
  "Allow Ready to save details about sensitive topics like health conditions from future meetings to memory.";
const MESSAGE_MEMORY_SETTINGS_LEARN_MORE = "Learn more";
const MESSAGE_MEMORY_SETTINGS_UPDATE_FAILED = "Could not update memory settings.";
const MESSAGE_MEMORY_SECTION_TITLE = "Privacy";
const MESSAGE_MEMORY_EVIDENCE_UNAVAILABLE = "This evidence is unavailable.";
const MESSAGE_MEMORY_EVIDENCE_TRY_AGAIN = "Try again";
const MESSAGE_MEMORY_BACK_TO_MEMORY = "Back to memory";
const MESSAGE_MEMORY_CLOSE = "Close memory";
const MESSAGE_MEMORY_VIEW_TRANSCRIPT = "View transcript";
const MESSAGE_MEMORY_FORGET = "Forget";
const MESSAGE_MEMORY_EVIDENCE_LABEL = "Meeting evidence";
const MESSAGE_MEMORY_SETTINGS_DOCS_HREF = "/docs/memory";
const MESSAGE_MEMORY_EVIDENCE_SPEAKER_SEPARATOR = " · ";
const MEMORY_EVIDENCE_TIME_FORMAT = { hour: "numeric", minute: "2-digit" } as const;
const MESSAGE_MEMORY_COPY_INLINE_SPACE = " ";

const MEMORY_DETAIL_MIN_TOP_OFFSET_PX = 24;
const MEMORY_DETAIL_MIN_HEIGHT_PX = 240;
const MEMORY_DETAIL_ANIMATION_DURATION_MS = 260;

function parseMemoryFilterScope(scope: string): Record<string, string> {
  return memoryFilterScopeSchema.parse(JSON.parse(scope));
}

const validDate = (value: string | null) =>
  value !== null && value !== "" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "";

function flattenMemoryListPages(data: InfiniteData<MemoryListPage, string> | undefined): RelationshipMemory[] {
  return data?.pages.flatMap((page) => page.memories) ?? [];
}

function flattenMemoryPeoplePages(data: InfiniteData<MemoryPeoplePage, string> | undefined): MemoryPerson[] {
  return data?.pages.flatMap((page) => page.people) ?? [];
}

function readMemoryListPageCount(data: InfiniteData<MemoryListPage, string> | undefined): number {
  if (data === undefined) {
    return 0;
  }

  return data.pages.length;
}

function readFirstMemoryListPageParam(data: InfiniteData<MemoryListPage, string> | undefined): string | undefined {
  const pageParams = data?.pageParams;
  if (!Array.isArray(pageParams) || pageParams.length === 0) {
    return undefined;
  }

  return pageParams[0];
}

function readActiveHTMLElement(): HTMLElement | null {
  const element = document.activeElement;

  return element instanceof HTMLElement ? element : null;
}
const dateLabel = (date: string) =>
  new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
function useMemorySession() {
  const { session } = useAuth();
  const token = session?.token ?? "",
    workspaceId = session?.user.workspaceId ?? "";

  return {
    token,
    workspaceId,
    key: ["relationship-memory", session?.user.id, workspaceId],
  };
}
function useMemoryStatus() {
  const { token, workspaceId, key } = useMemorySession();

  return useQuery({
    queryKey: [...key, "status"],
    queryFn: () => getMemoryStatus({ token, workspaceId }),
    enabled: token !== "" && workspaceId !== "",
    refetchInterval: MEMORY_STATUS_REFETCH_INTERVAL_MS,
    gcTime: MEMORY_BROWSER_CACHE_TIME_MS,
  });
}
export function MemorySettingsPanel() {
  const { token, workspaceId, key } = useMemorySession(),
    status = useMemoryStatus(),
    client = useQueryClient();
  const [error, setError] = useState(""),
    [isSaving, setIsSaving] = useState(false);
  async function save(patch: Partial<MemoryPreferences>) {
    if (!status.data) {
      return;
    }
    setIsSaving(true);
    setError("");
    try {
      await saveMemorySettings({ token, workspaceId, preferences: { ...status.data.preferences, ...patch } });
      await client.invalidateQueries({ queryKey: key });
    } catch (e) {
      setError(getApiErrorMessage({ error: e, fallback: MESSAGE_MEMORY_SETTINGS_UPDATE_FAILED }));
    } finally {
      setIsSaving(false);
    }
  }
  const prefs = status.data?.preferences;

  return (
    <section className="settings-section relationship-memory-settings">
      <header className="settings-section-header">
        <h1>{MESSAGE_MEMORY_SECTION_TITLE}</h1>
      </header>
      {status.isPending ? null : status.isError ? (
        <p role="alert">
          {MESSAGE_MEMORY_SETTINGS_LOAD_FAILED}
          {MESSAGE_MEMORY_COPY_INLINE_SPACE}
          <button onClick={() => void status.refetch()}>{MESSAGE_MEMORY_SETTINGS_TRY_AGAIN}</button>
        </p>
      ) : !status.data.available ? (
        <p>{MESSAGE_MEMORY_SETTINGS_UNAVAILABLE}</p>
      ) : (
        prefs !== undefined && (
          <div className="relationship-memory-setting">
            <div>
              <label htmlFor="memory-sensitive">{MESSAGE_MEMORY_SETTINGS_SENSITIVE_LABEL}</label>
              <p id="memory-sensitive-description">
                {MESSAGE_MEMORY_SETTINGS_SENSITIVE_DESCRIPTION}
                {MESSAGE_MEMORY_COPY_INLINE_SPACE}
                <Link
                  className="relationship-memory-learn-more"
                  href={MESSAGE_MEMORY_SETTINGS_DOCS_HREF}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {MESSAGE_MEMORY_SETTINGS_LEARN_MORE} <MemoryIcon name="external" />
                </Link>
              </p>
            </div>
            <input
              id="memory-sensitive"
              type="checkbox"
              role="switch"
              aria-describedby="memory-sensitive-description"
              aria-checked={prefs.includeSensitive}
              checked={prefs.includeSensitive}
              disabled={isSaving}
              onChange={(e) =>
                void save({
                  /** @external memory preferences wire field */
                  includeSensitive: e.target.checked,
                })
              }
            />
          </div>
        )
      )}
      {error !== "" ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function focusMemoryDetailControls(input: {
  closeButton: RefObject<HTMLButtonElement | null>;
  transcriptButton: RefObject<HTMLButtonElement | null>;
  isTranscriptOpen: boolean;
}) {
  if (input.isTranscriptOpen) {
    input.closeButton.current?.focus({ preventScroll: true });
  } else {
    input.transcriptButton.current?.focus({ preventScroll: true });
  }
}

function useMemoryDetailTranscriptLayout(input: {
  card: RefObject<HTMLElement | null>;
  transcriptButton: RefObject<HTMLButtonElement | null>;
  closeButton: RefObject<HTMLButtonElement | null>;
  transitionHeight: RefObject<number | null>;
  animation: RefObject<Animation | null>;
  isStack: boolean;
  isTranscriptOpen: boolean;
}) {
  const { card, transcriptButton, closeButton, transitionHeight, animation, isStack, isTranscriptOpen } = input;
  useLayoutEffect(() => {
    const element = card.current;
    const scroller = element?.closest<HTMLElement>(".relationship-memory-content");
    if (isStack) {
      if (transitionHeight.current !== null) {
        transitionHeight.current = null;
        focusMemoryDetailControls({ closeButton, transcriptButton, isTranscriptOpen });
      }

      return;
    }
    if (element === null || scroller === null || scroller === undefined) {
      return;
    }
    const isReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const previousScrollTop = scroller.scrollTop;
    const resize = () => {
      const page = element.closest<HTMLElement>(".relationship-memory-page");
      const paddingTop = parseFloat(getComputedStyle(scroller).paddingTop);
      const pageMarginTop = page !== null ? parseFloat(getComputedStyle(page).marginTop) : Number.NaN;
      const top = Math.max(
        MEMORY_DETAIL_MIN_TOP_OFFSET_PX,
        (Number.isFinite(paddingTop) ? paddingTop : 0) + (Number.isFinite(pageMarginTop) ? pageMarginTop : 0),
      );
      element.style.height = `${Math.max(
        MEMORY_DETAIL_MIN_HEIGHT_PX,
        scroller.clientHeight - top - MEMORY_DETAIL_MIN_TOP_OFFSET_PX,
      )}px`;
      scroller.scrollTo({
        top: scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - top,
        behavior: isReducedMotion ? "instant" : "smooth",
      });
    };
    if (isTranscriptOpen) {
      resize();
    } else {
      element.style.removeProperty("height");
    }
    animation.current?.cancel();
    if (transitionHeight.current !== null) {
      if (!isReducedMotion && typeof element.animate === "function") {
        animation.current = element.animate(
          [{ height: `${transitionHeight.current}px` }, { height: `${element.getBoundingClientRect().height}px` }],
          { duration: MEMORY_DETAIL_ANIMATION_DURATION_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      }
      transitionHeight.current = null;
      focusMemoryDetailControls({ closeButton, transcriptButton, isTranscriptOpen });
    }
    if (!isTranscriptOpen) {
      return;
    }
    const observer = new ResizeObserver(resize);
    observer.observe(scroller);

    return () => {
      observer.disconnect();
      element.style.removeProperty("height");
      scroller.scrollTo({ top: previousScrollTop, behavior: "instant" });
    };
  }, [isTranscriptOpen, isStack, animation, card, closeButton, transcriptButton, transitionHeight]);
}

function MemoryDetailEvidence({
  evidence,
}: {
  evidence: {
    isPending: boolean;
    isError: boolean;
    data?: Awaited<ReturnType<typeof getMemoryEvidence>>;
    refetch: () => Promise<unknown>;
  };
}) {
  return (
    <section className="relationship-evidence" aria-label={MESSAGE_MEMORY_EVIDENCE_LABEL}>
      {evidence.isPending ? null : evidence.isError ? (
        <p role="alert">
          {MESSAGE_MEMORY_EVIDENCE_UNAVAILABLE}
          {MESSAGE_MEMORY_COPY_INLINE_SPACE}
          <button onClick={() => void evidence.refetch()}>{MESSAGE_MEMORY_EVIDENCE_TRY_AGAIN}</button>
        </p>
      ) : (
        evidence.data?.evidence.map((e, i) => (
          <blockquote key={`${e.segmentId}-${i}`}>
            <p>{e.quote}</p>
            <footer>
              {e.speakerName}
              {MESSAGE_MEMORY_EVIDENCE_SPEAKER_SEPARATOR}
              <time dateTime={e.startedAt}>
                {new Date(e.startedAt).toLocaleTimeString(undefined, MEMORY_EVIDENCE_TIME_FORMAT)}
              </time>
            </footer>
          </blockquote>
        ))
      )}
    </section>
  );
}

function MemoryDetailFooter({
  transcriptButton,
  isTranscriptOpen,
  isBusy,
  onToggleTranscript,
  onForget,
}: {
  transcriptButton: RefObject<HTMLButtonElement | null>;
  isTranscriptOpen: boolean;
  isBusy: boolean;
  onToggleTranscript: () => void;
  onForget: () => void;
}) {
  return (
    <div className="relationship-detail-footer" hidden={isTranscriptOpen}>
      <button
        ref={transcriptButton}
        className="relationship-evidence-toggle"
        aria-expanded={isTranscriptOpen}
        onClick={onToggleTranscript}
      >
        {MESSAGE_MEMORY_VIEW_TRANSCRIPT} <MemoryIcon name="external" />
      </button>
      <div>
        <button className="relationship-forget-button" disabled={isBusy} onClick={onForget}>
          {MESSAGE_MEMORY_FORGET}
        </button>
      </div>
    </div>
  );
}

function MemoryDetail({
  memory,
  onClose,
  onAction,
  people,
  returnTo,
  isBusy,
  isTranscriptOpen,
  onTranscriptChange,
  isStack = false,
  isActive = true,
}: {
  memory: RelationshipMemory;
  isStack?: boolean;
  isActive?: boolean;
  onClose: () => void;
  onAction: (input: { action: "forget"; id: string }) => void;
  people: MemoryPerson[];
  returnTo: string;
  isBusy: boolean;
  isTranscriptOpen: boolean;
  onTranscriptChange: (input: { isOpen: boolean }) => void;
}) {
  const { token, workspaceId, key } = useMemorySession();
  const card = useRef<HTMLDivElement>(null);
  const transcriptButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const transitionHeight = useRef<number | null>(null);
  const animation = useRef<Animation | null>(null);
  function setTranscript(input: { isOpen: boolean }) {
    transitionHeight.current = card.current?.getBoundingClientRect().height ?? null;
    onTranscriptChange(input);
  }
  useMemoryDetailTranscriptLayout({
    card,
    transcriptButton,
    closeButton,
    transitionHeight,
    animation,
    isStack,
    isTranscriptOpen,
  });
  useEffect(() => () => animation.current?.cancel(), []);
  const evidence = useQuery({
    queryKey: [...key, "evidence", memory.id],
    queryFn: () => getMemoryEvidence({ token, workspaceId, memoryId: memory.id }),
    gcTime: 0,
    enabled: isActive,
  });
  const memoryPeople = (evidence.data?.people ?? people).filter((person) => memory.personIds.includes(person.id));
  useEffect(() => {
    if (!isStack) {
      closeButton.current?.focus({ preventScroll: true });
    }
  }, [isStack]);

  return (
    <article
      ref={card}
      className={`relationship-memory-detail${isTranscriptOpen ? " is-transcript-open" : ""}`}
      aria-label={memory.title}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (isTranscriptOpen) {
            setTranscript({ isOpen: false });
          } else {
            onClose();
          }
        }
      }}
    >
      <header>
        <h2>
          <MemoryPersonText text={memory.title} people={memoryPeople} returnTo={returnTo} />
        </h2>
        <button
          ref={closeButton}
          className={`relationship-icon-button${isTranscriptOpen ? "" : " relationship-memory-close"}`}
          aria-label={isTranscriptOpen ? MESSAGE_MEMORY_BACK_TO_MEMORY : MESSAGE_MEMORY_CLOSE}
          onClick={() => (isTranscriptOpen ? setTranscript({ isOpen: false }) : onClose())}
        >
          <MemoryIcon name={isTranscriptOpen ? "minimize" : "close"} />
        </button>
      </header>
      <p className="relationship-detail-description" hidden={isTranscriptOpen}>
        <MemoryPersonText text={memory.description} people={memoryPeople} returnTo={returnTo} />
      </p>
      <MemoryDetailFooter
        transcriptButton={transcriptButton}
        isTranscriptOpen={isTranscriptOpen}
        isBusy={isBusy}
        onToggleTranscript={() => setTranscript({ isOpen: !isTranscriptOpen })}
        onForget={() => onAction({ action: "forget", id: memory.id })}
      />
      {isTranscriptOpen ? <MemoryDetailEvidence evidence={evidence} /> : null}
    </article>
  );
}
const MESSAGE_FORGET_DIALOG_TITLE = "Forget this information?";
const MESSAGE_FORGET_DIALOG_BODY =
  "This memory will be removed from All and Where things stand. Summary lines based on it are removed too. Your original meetings will stay available.";
const MESSAGE_FORGET_DIALOG_CANCEL = "Cancel";
const MESSAGE_FORGET_DIALOG_FORGET = "Forget";
const MESSAGE_FORGET_DIALOG_FORGETTING = "Forgetting…";

const MESSAGE_MEMORY_PERSON_UNAVAILABLE = "This person is unavailable.";
const MESSAGE_MEMORY_TRY_AGAIN = "Try again";
const MESSAGE_MEMORY_NO_EMAIL = "No email verified";
const MESSAGE_MEMORY_SUMMARY = "Summary";
const MESSAGE_MEMORY_PAST_MEETINGS = "Past meetings";
const MESSAGE_MEMORY_WHERE_THINGS_STAND = "Where things stand";
const MESSAGE_MEMORY_NO_SUMMARY = "No summary yet.";
const MESSAGE_MEMORY_NO_DEVELOPMENTS = "No open developments recorded.";
const MESSAGE_MEMORY_VIEW_ALL = "View all memories";
const MESSAGE_MEMORY_BACK = "Back";
const MESSAGE_MEMORY_BROWSER_LABEL = "Memory browser";
const MESSAGE_MEMORY_PERSON_FALLBACK = "Person";
const MESSAGE_MEMORY_PEOPLE_NAV = "People";
const MESSAGE_MEMORY_ALL_NAV = "All memories";
const MESSAGE_MEMORY_LOADING = "Loading memory…";
const MESSAGE_MEMORY_LOAD_FAILED = "Could not load memory.";
const MESSAGE_MEMORY_UNAVAILABLE = "Memory is not available in this environment yet.";
const MESSAGE_MEMORY_MEMORIES_LOAD_FAILED = "Could not load memories.";
const MESSAGE_MEMORY_PEOPLE_LOAD_FAILED = "Could not load people.";
const MESSAGE_MEMORY_PLAN_CHECK_FAILED = "Could not check your plan.";
const MESSAGE_MEMORY_UPDATE_FAILED = "Could not update memory.";
const MESSAGE_MEMORY_LINK_UNAVAILABLE = "This memory is no longer available.";
const MESSAGE_MEMORY_PERSON_ID_REQUIRED = "A person id is required to load memory.";
const MESSAGE_MEMORY_PREPARING = "Preparing memories";
const MESSAGE_MEMORY_PREPARING_LABEL = "Preparing memories";
const MESSAGE_MEMORY_NO_MEMORIES = "No memories found";
const MESSAGE_MEMORY_NO_PEOPLE = "No people found";
const MESSAGE_MEMORY_LOAD_NEWER_MEMORIES = "Load newer memories";
const MESSAGE_MEMORY_LATEST_MEMORIES = "Latest memories";
const MESSAGE_MEMORY_LOAD_NEWER_PEOPLE = "Load newer people";
const MESSAGE_MEMORY_SETTINGS_LINK = "Memory settings";
const MESSAGE_MEMORY_OPEN_PERSON_PREFIX = "Open ";

const MEMORY_UPGRADE_PREVIEW_COUNT = 8;
const MEMORY_UPGRADE_FADE_HEIGHT_FALLBACK_PX = 160;
const PEOPLE_CHUNK_SIZE = 50;
const PEOPLE_ROW_HEIGHT_TOLERANCE_PX = 0.5;

function ForgetDialog({
  onCancel,
  onConfirm,
  isBusy,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  isBusy: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog ref={ref} className="relationship-memory-dialog" onCancel={onCancel} aria-labelledby="forget-memory-title">
      <h2 id="forget-memory-title">{MESSAGE_FORGET_DIALOG_TITLE}</h2>
      <p>{MESSAGE_FORGET_DIALOG_BODY}</p>
      <div className="relationship-memory-actions">
        <button onClick={onCancel} disabled={isBusy}>
          {MESSAGE_FORGET_DIALOG_CANCEL}
        </button>
        <button onClick={onConfirm} disabled={isBusy}>
          {isBusy ? MESSAGE_FORGET_DIALOG_FORGETTING : MESSAGE_FORGET_DIALOG_FORGET}
        </button>
      </div>
    </dialog>
  );
}

function WorkspaceMemoryPersonHeader({ person }: { person: Awaited<ReturnType<typeof getMemoryPerson>>["person"] }) {
  const personEmail = person.email;
  const verifiedPersonEmail =
    personEmail !== "" && personEmail !== undefined && personEmail !== null ? personEmail : null;

  return (
    <header className="relationship-person-header">
      <PersonInitials name={person.name} imageUrl={person.imageUrl} />
      <div>
        <h2>{person.name}</h2>
        <div className="workspace-meeting-meta-pills">
          {verifiedPersonEmail !== null ? (
            <a className="workspace-meta-pill relationship-person-profile-link" href={`mailto:${verifiedPersonEmail}`}>
              {verifiedPersonEmail}
              <MemoryIcon name="external" />
            </a>
          ) : (
            <span className="workspace-meta-pill">{MESSAGE_MEMORY_NO_EMAIL}</span>
          )}
          {person.profileLinks?.map((link) => (
            <a
              key={link.url}
              className="workspace-meta-pill relationship-person-profile-link"
              href={link.url}
              target="_blank"
              rel="noreferrer"
            >
              {link.label}
              <MemoryIcon name="external" />
            </a>
          ))}
        </div>
      </div>
    </header>
  );
}

function WorkspaceMemoryPersonPanel({
  personId,
  person,
  standingMemories,
}: {
  personId: string;
  person: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getMemoryPerson>>>>;
  standingMemories: RelationshipMemory[];
}) {
  if (person.isPending) {
    return null;
  }
  if (person.isError) {
    return (
      <p role="alert">
        {MESSAGE_MEMORY_PERSON_UNAVAILABLE}
        {MESSAGE_MEMORY_COPY_INLINE_SPACE}
        <button onClick={() => void person.refetch()}>{MESSAGE_MEMORY_TRY_AGAIN}</button>
      </p>
    );
  }

  return (
    <>
      <WorkspaceMemoryPersonHeader person={person.data.person} />
      <section className="relationship-person-section">
        <h2>{MESSAGE_MEMORY_SUMMARY}</h2>
        {(person.data.projection?.summary.length ?? 0) > 0 ? (
          <p>{person.data.projection?.summary.map((sentence) => sentence.text).join(" ")}</p>
        ) : !person.data.processing ? (
          <p className="relationship-memory-muted">{MESSAGE_MEMORY_NO_SUMMARY}</p>
        ) : null}
      </section>
      <section className="relationship-person-section">
        <h2>{MESSAGE_MEMORY_PAST_MEETINGS}</h2>
        <ol className="relationship-person-meetings">
          {person.data.meetings.map((m) => (
            <li key={m.id}>
              <Link href={`/workspace/${m.id}`}>
                <span className="relationship-timeline-marker">
                  <ArchiveTrayIcon />
                </span>
                <span className="relationship-meeting-title">
                  {m.title}
                  <span className="relationship-standing-date">
                    {MESSAGE_MEMORY_EVIDENCE_SPEAKER_SEPARATOR}
                    {dateLabel(m.occurredAt)} <MemoryIcon name="external" />
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </section>
      <section className="relationship-person-section">
        <h2>{MESSAGE_MEMORY_WHERE_THINGS_STAND}</h2>
        {standingMemories.length !== 0 ? (
          <ol className="relationship-standing-list">
            {standingMemories.map((memory) => (
              <li key={memory.id}>
                <span className="relationship-timeline-marker">
                  <MemoryTimelineArrow />
                </span>
                <Link className="relationship-memory-source-link" href={`/workspace/memory?memory=${memory.id}`}>
                  <span className="relationship-standing-title">{memory.title}</span>
                  <span className="relationship-standing-date">
                    {MESSAGE_MEMORY_EVIDENCE_SPEAKER_SEPARATOR}
                    <time dateTime={memory.occurredAt} title={dateLabel(memory.occurredAt)}>
                      {memoryAge(memory.occurredAt)}
                    </time>
                    {MESSAGE_MEMORY_COPY_INLINE_SPACE}
                    <MemoryIcon name="external" />
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        ) : !person.data.processing ? (
          <p className="relationship-memory-muted">{MESSAGE_MEMORY_NO_DEVELOPMENTS}</p>
        ) : null}
      </section>
      <Link className="relationship-history-link" href={`/workspace/memory?person=${personId}`}>
        {MESSAGE_MEMORY_VIEW_ALL} <MemoryIcon name="external" />
      </Link>
    </>
  );
}

// The People layout owns this page so navigating to a person preserves the
// shell, plan query, and upgrade card instead of mounting them again.
export function WorkspaceMemoryPeoplePage() {
  const { personId } = useParams<{ personId?: string }>();

  return <WorkspaceMemoryPage view="people" personId={personId} />;
}

function syncWorkspaceMemoryDeepLink(input: {
  isMemoryNavigationEnabled: boolean;
  view: "all" | "people";
  requestedMemoryId: string | null;
  memories: UseInfiniteQueryResult<InfiniteData<MemoryListPage, string>>;
  handledMemoryLink: RefObject<string | null>;
  memoryLinkSearch: RefObject<string | null>;
  scrollToMemory: RefObject<string | null>;
  setError: (message: string) => void;
  setTranscriptMemoryId: (id: string | null) => void;
  setOpened: (memory: RelationshipMemory | null) => void;
  listOptions: ReturnType<typeof memoryListOptions>;
  client: ReturnType<typeof useQueryClient>;
}) {
  const {
    isMemoryNavigationEnabled,
    view,
    requestedMemoryId,
    memories,
    handledMemoryLink,
    memoryLinkSearch,
    scrollToMemory,
    setError,
    setTranscriptMemoryId,
    setOpened,
    listOptions,
    client,
  } = input;
  if (requestedMemoryId === null || requestedMemoryId === "") {
    handledMemoryLink.current = null;
    memoryLinkSearch.current = null;

    return;
  }
  if (
    !isMemoryNavigationEnabled ||
    view !== "all" ||
    memories.isPlaceholderData ||
    handledMemoryLink.current === requestedMemoryId
  ) {
    return;
  }
  const memory = flattenMemoryListPages(memories.data).find((item) => item.id === requestedMemoryId);
  if (memory !== undefined) {
    handledMemoryLink.current = requestedMemoryId;
    setError("");
    scrollToMemory.current = memory.id;
    setTranscriptMemoryId(null);
    setOpened(memory);

    return;
  }
  paginateWorkspaceMemoryDeepLink({
    requestedMemoryId,
    memories,
    handledMemoryLink,
    memoryLinkSearch,
    setError,
    listOptions,
    client,
  });
}

function paginateWorkspaceMemoryDeepLink(input: {
  requestedMemoryId: string;
  memories: UseInfiniteQueryResult<InfiniteData<MemoryListPage, string>>;
  handledMemoryLink: RefObject<string | null>;
  memoryLinkSearch: RefObject<string | null>;
  setError: (message: string) => void;
  listOptions: ReturnType<typeof memoryListOptions>;
  client: ReturnType<typeof useQueryClient>;
}) {
  const { requestedMemoryId, memories, handledMemoryLink, memoryLinkSearch, setError, listOptions, client } = input;
  if (
    memories.isSuccess &&
    !memories.isFetching &&
    memoryLinkSearch.current !== JSON.stringify([listOptions.queryKey, requestedMemoryId])
  ) {
    // A retained window may omit newer pages. Start an unresolved link from
    // the head once, then allow the forward search to cross the cache limit.
    memoryLinkSearch.current = JSON.stringify([listOptions.queryKey, requestedMemoryId]);
    const firstPageParam = readFirstMemoryListPageParam(memories.data);
    if (firstPageParam !== undefined && firstPageParam !== "") {
      void client.resetQueries({ queryKey: listOptions.queryKey, exact: true });
    } else if (memories.hasNextPage) {
      void memories.fetchNextPage();
    } else {
      handledMemoryLink.current = requestedMemoryId;
      setError(MESSAGE_MEMORY_LINK_UNAVAILABLE);
    }

    return;
  }
  if (memories.hasNextPage && !memories.isFetching && !memories.isFetchNextPageError) {
    void memories.fetchNextPage();

    return;
  }
  if (memories.isSuccess && !memories.hasNextPage && !memories.isFetching) {
    handledMemoryLink.current = requestedMemoryId;
    setError(MESSAGE_MEMORY_LINK_UNAVAILABLE);
  }
}

function useWorkspaceMemoryDeepLinkEffect(input: {
  isMemoryNavigationEnabled: boolean;
  view: "all" | "people";
  requestedMemoryId: string | null;
  memories: UseInfiniteQueryResult<InfiniteData<MemoryListPage, string>>;
  handledMemoryLink: RefObject<string | null>;
  memoryLinkSearch: RefObject<string | null>;
  scrollToMemory: RefObject<string | null>;
  setError: (message: string) => void;
  setTranscriptMemoryId: (id: string | null) => void;
  setOpened: (memory: RelationshipMemory | null) => void;
  listOptions: ReturnType<typeof memoryListOptions>;
  client: ReturnType<typeof useQueryClient>;
}) {
  const { isMemoryNavigationEnabled, view, requestedMemoryId, memories, listOptions, client } = input;
  useEffect(() => {
    syncWorkspaceMemoryDeepLink(input);
  }, [
    isMemoryNavigationEnabled,
    view,
    requestedMemoryId,
    memories.data,
    memories.hasNextPage,
    memories.isFetching,
    memories.isFetchNextPageError,
    memories.isSuccess,
    memories.fetchNextPage,
    memories.isPlaceholderData,
    client,
    listOptions.queryKey,
  ]);
}

function useWorkspaceMemoryResultEffects(input: {
  personId?: string;
  view: "all" | "people";
  opened: RelationshipMemory | null;
  setOpened: (memory: RelationshipMemory | null) => void;
  setTranscriptMemoryId: (id: string | null) => void;
  rows: RelationshipMemory[];
  memories: UseInfiniteQueryResult<InfiniteData<MemoryListPage, string>>;
  isMemoryNavigationEnabled: boolean;
  requestedMemoryId: string | null;
  handledMemoryLink: RefObject<string | null>;
  memoryLinkSearch: RefObject<string | null>;
  scrollToMemory: RefObject<string | null>;
  setError: (message: string) => void;
  listOptions: ReturnType<typeof memoryListOptions>;
  client: ReturnType<typeof useQueryClient>;
  virtualList: RefObject<MemoryVirtualListHandle | null>;
}) {
  const {
    personId,
    view,
    opened,
    setOpened,
    setTranscriptMemoryId,
    rows,
    memories,
    isMemoryNavigationEnabled,
    requestedMemoryId,
    handledMemoryLink,
    memoryLinkSearch,
    scrollToMemory,
    setError,
    listOptions,
    client,
    virtualList,
  } = input;
  useEffect(() => {
    if (Boolean(personId) || view !== "all" || !opened || memories.isPlaceholderData || !memories.isSuccess) {
      return;
    }
    const current = rows.find((memory) => memory.id === opened.id);
    if (current && current !== opened) {
      setOpened(current);
    } else if (!current) {
      setOpened(null);
      setTranscriptMemoryId(null);
    }
  }, [personId, view, rows, opened, memories.isPlaceholderData, memories.isSuccess, setOpened, setTranscriptMemoryId]);
  useWorkspaceMemoryDeepLinkEffect({
    isMemoryNavigationEnabled,
    view,
    requestedMemoryId,
    memories,
    handledMemoryLink,
    memoryLinkSearch,
    scrollToMemory,
    setError,
    setTranscriptMemoryId,
    setOpened,
    listOptions,
    client,
  });
  useLayoutEffect(() => {
    if (!opened || scrollToMemory.current !== opened.id) {
      return;
    }
    const index = rows.findIndex((memory) => memory.id === opened.id);
    const frame = requestAnimationFrame(() => {
      if (index >= 0) {
        virtualList.current?.scrollToIndex(index, "instant");
      }
    });
    scrollToMemory.current = null;

    return () => cancelAnimationFrame(frame);
  }, [opened, rows]);
}

function useWorkspaceMemoryPersonDetail(input: {
  key: ReturnType<typeof useMemorySession>["key"];
  token: string;
  workspaceId: string;
  personId?: string;
  isMemoryNavigationEnabled: boolean;
}) {
  const { key, token, workspaceId, personId, isMemoryNavigationEnabled } = input;

  return useQuery({
    queryKey: [...key, "person", personId],
    queryFn: () => {
      if (personId === undefined) {
        throw new Error(MESSAGE_MEMORY_PERSON_ID_REQUIRED);
      }

      return getMemoryPerson({ token, workspaceId, personId });
    },
    enabled: isMemoryNavigationEnabled && personId !== undefined && personId !== "",
    refetchInterval: MEMORY_QUERY_REFETCH_INTERVAL_MS,
    gcTime: MEMORY_BROWSER_CACHE_TIME_MS,
  });
}

function buildWorkspaceMemoryPeopleFilters(input: {
  view: "all" | "people";
  search: string;
  category: string;
  from: string;
  to: string;
  operators: { categoryOperator: string; personOperator: string; dateOperator: string };
}): Record<string, string> {
  if (input.view !== "people") {
    return {};
  }

  return {
    ...(input.search !== "" ? { q: input.search } : {}),
    ...(input.category !== "" ? { category: input.category, categoryOperator: input.operators.categoryOperator } : {}),
    ...(input.from !== "" ? { from: input.from } : {}),
    ...(input.to !== "" ? { to: input.to } : {}),
    ...(input.from !== "" || input.to !== "" ? { dateOperator: input.operators.dateOperator } : {}),
  };
}

function useWorkspaceMemoryListQueries({
  client,
  token,
  workspaceId,
  key,
  view,
  search,
  category,
  from,
  to,
  operators,
  personFilter,
  isMemoryNavigationEnabled,
}: {
  client: ReturnType<typeof useQueryClient>;
  token: string;
  workspaceId: string;
  key: ReturnType<typeof useMemorySession>["key"];
  view: "all" | "people";
  search: string;
  category: string;
  from: string;
  to: string;
  operators: { categoryOperator: string; personOperator: string; dateOperator: string };
  personFilter: string;
  isMemoryNavigationEnabled: boolean;
}): {
  filters: Record<string, string>;
  memoryQueryScope: string;
  listOptions: ReturnType<typeof memoryListOptions>;
  memories: UseInfiniteQueryResult<InfiniteData<MemoryListPage, string>>;
  people: UseInfiniteQueryResult<InfiniteData<MemoryPeoplePage, string>>;
  pickerSearch: string | null;
  setPickerSearch: (value: string | null) => void;
  pickerPeople: UseInfiniteQueryResult<InfiniteData<MemoryPeoplePage, string>>;
  filteredPeople: MemoryPerson[];
} {
  const filters = {
    ...operators,
    ...(search !== "" ? { q: search } : {}),
    ...(category !== "" ? { category } : {}),
    ...(personFilter !== "" ? { personId: personFilter } : {}),
    ...(from !== "" ? { from } : {}),
    ...(to !== "" ? { to } : {}),
  };
  const memoryQueryScope = JSON.stringify(filters);
  const listOptions = useMemo(
    () =>
      memoryListOptions({
        client,
        session: {
          token,
          workspaceId,
          userId: key[1] ?? "",
        },
        filters: parseMemoryFilterScope(memoryQueryScope),
      }),
    [client, token, workspaceId, key[1], memoryQueryScope],
  );
  const memories = useInfiniteQuery({
    ...listOptions,
    placeholderData: (...args) => {
      const previous = args[0];
      const previousQuery = args[1];

      return previousQuery?.queryKey[1] === key[1] && previousQuery?.queryKey[2] === key[2] ? previous : undefined;
    },
    enabled: isMemoryNavigationEnabled && view === "all",
    refetchInterval: MEMORY_QUERY_REFETCH_INTERVAL_MS,
  });
  const people = useInfiniteQuery({
    ...memoryPeopleOptions({
      session: { token, workspaceId, userId: key[1] ?? "" },
      filters: buildWorkspaceMemoryPeopleFilters({ view, search, category, from, to, operators }),
    }),
    enabled: isMemoryNavigationEnabled,
    refetchInterval: MEMORY_QUERY_REFETCH_INTERVAL_MS,
  });
  const [pickerSearch, setPickerSearch] = useState<string | null>(null);
  const pickerPeople = useInfiniteQuery({
    ...memoryPeopleOptions({
      session: { token, workspaceId, userId: key[1] ?? "" },
      filters: pickerSearch !== null && pickerSearch !== "" ? { q: pickerSearch } : {},
    }),
    enabled: isMemoryNavigationEnabled && pickerSearch !== null,
  });
  const filteredPeople = flattenMemoryPeoplePages(people.data).filter((person) =>
    memoryPersonMatchesFilters({ person, filters }),
  );

  return {
    filters,
    memoryQueryScope,
    listOptions,
    memories,
    people,
    pickerSearch,
    setPickerSearch,
    pickerPeople,
    filteredPeople,
  };
}

function WorkspaceMemoryPeopleResults({
  people,
  filteredPeople,
  browserHref,
}: {
  people: ReturnType<typeof useWorkspaceMemoryListQueries>["people"];
  filteredPeople: MemoryPerson[];
  browserHref: string;
}) {
  return people.isPending ? null : people.isError && people.data === undefined ? (
    <p role="alert">
      {MESSAGE_MEMORY_PEOPLE_LOAD_FAILED}
      {MESSAGE_MEMORY_COPY_INLINE_SPACE}
      <button onClick={() => void people.refetch()}>{MESSAGE_MEMORY_TRY_AGAIN}</button>
    </p>
  ) : (
    <>
      {people.hasPreviousPage ? (
        <button
          className="relationship-memory-load-more"
          disabled={people.isFetching}
          onClick={() => {
            void people.fetchPreviousPage();
          }}
        >
          {MESSAGE_MEMORY_LOAD_NEWER_PEOPLE}
        </button>
      ) : null}
      <MemoryPeopleList returnTo={browserHref} people={filteredPeople} />
      {people.hasNextPage ? (
        <MemoryLoadMore
          loading={people.isFetching}
          failed={people.isFetchNextPageError}
          load={() => {
            void people.fetchNextPage();
          }}
        />
      ) : null}
    </>
  );
}

function WorkspaceMemoryProcessingRow({ isTranscriptFocused }: { isTranscriptFocused: boolean }) {
  return (
    <ol className="relationship-memory-list relationship-memory-processing-list">
      <li
        className="relationship-memory-row relationship-memory-processing"
        role="status"
        aria-label={MESSAGE_MEMORY_PREPARING_LABEL}
        inert={isTranscriptFocused}
      >
        <div className="relationship-memory-open">
          <span
            className="relationship-memory-title live-end-meeting-step-shimmer"
            data-text={MESSAGE_MEMORY_PREPARING}
            aria-hidden="true"
          >
            {MESSAGE_MEMORY_PREPARING}
          </span>
        </div>
      </li>
    </ol>
  );
}

function WorkspaceMemoryAllResultsLoadNewer({
  memories,
  client,
  listOptions,
}: {
  memories: UseInfiniteQueryResult<InfiniteData<MemoryListPage, string>>;
  client: ReturnType<typeof useQueryClient>;
  listOptions: ReturnType<typeof memoryListOptions>;
}) {
  if (!memories.hasPreviousPage) {
    return null;
  }

  return (
    <>
      <button
        className="relationship-memory-load-more"
        disabled={memories.isFetching}
        onClick={() => {
          void memories.fetchPreviousPage();
        }}
      >
        {MESSAGE_MEMORY_LOAD_NEWER_MEMORIES}
      </button>
      <button
        className="relationship-memory-load-more"
        onClick={() => {
          void client.resetQueries({ queryKey: listOptions.queryKey, exact: true });
        }}
      >
        {MESSAGE_MEMORY_LATEST_MEMORIES}
      </button>
    </>
  );
}

function WorkspaceMemoryStackMemoryCard({
  memory,
  isActive,
  people,
  browserHref,
  isBusy,
  transcriptMemoryId,
  setTranscriptMemoryId,
  cardBrowser,
  detailAction,
}: {
  memory: RelationshipMemory;
  isActive: boolean;
  people: ReturnType<typeof useWorkspaceMemoryListQueries>["people"];
  browserHref: string;
  isBusy: boolean;
  transcriptMemoryId: string | null;
  setTranscriptMemoryId: (id: string | null) => void;
  cardBrowser: RefObject<MemoryCardBrowserHandle | null>;
  detailAction: (input: { action: "forget"; id: string }) => void;
}) {
  return (
    <MemoryDetail
      key={memory.id}
      memory={memory}
      isStack
      isActive={isActive}
      people={flattenMemoryPeoplePages(people.data)}
      returnTo={browserHref}
      isBusy={isBusy}
      isTranscriptOpen={transcriptMemoryId === memory.id}
      onTranscriptChange={({ isOpen }) => setTranscriptMemoryId(isOpen ? memory.id : null)}
      onClose={() => cardBrowser.current?.selectLayout("list")}
      onAction={detailAction}
    />
  );
}

type WorkspaceMemoryAllResultsBrowserProps = {
  memories: ReturnType<typeof useWorkspaceMemoryListQueries>["memories"];
  rows: RelationshipMemory[];
  cardBrowser: RefObject<MemoryCardBrowserHandle | null>;
  virtualList: RefObject<MemoryVirtualListHandle | null>;
  memoryList: RefObject<HTMLDivElement | null>;
  arrivals: ReturnType<typeof useMemoryArrivals>;
  opened: RelationshipMemory | null;
  isTranscriptFocused: boolean;
  isForgetDialogOpen: boolean;
  isBusy: boolean;
  people: ReturnType<typeof useWorkspaceMemoryListQueries>["people"];
  browserHref: string;
  detail: React.ReactNode;
  detailAction: (input: { action: "forget"; id: string }) => void;
  transcriptMemoryId: string | null;
  setTranscriptMemoryId: (id: string | null) => void;
  setDisplayMode: (mode: MemoryDisplayMode) => void;
  setOpened: (memory: RelationshipMemory | null) => void;
  onOpenMemory: (memory: RelationshipMemory) => void;
  displayMode: MemoryDisplayMode;
  client: ReturnType<typeof useQueryClient>;
  listOptions: ReturnType<typeof memoryListOptions>;
};

function WorkspaceMemoryAllResultsBrowser(props: WorkspaceMemoryAllResultsBrowserProps) {
  const {
    memories,
    rows,
    cardBrowser,
    virtualList,
    memoryList,
    arrivals,
    opened,
    isTranscriptFocused,
    isForgetDialogOpen,
    isBusy,
    people,
    browserHref,
    detail,
    detailAction,
    transcriptMemoryId,
    setTranscriptMemoryId,
    setDisplayMode,
    setOpened,
    onOpenMemory,
    displayMode,
    client,
    listOptions,
  } = props;

  return (
    <>
      <WorkspaceMemoryAllResultsLoadNewer memories={memories} client={client} listOptions={listOptions} />
      <MemoryCardBrowser
        ref={cardBrowser}
        listRef={virtualList}
        {...arrivals}
        memories={rows}
        mode={displayMode}
        selectedId={opened?.id}
        disabled={isTranscriptFocused || isForgetDialogOpen}
        focused={isTranscriptFocused}
        onModeChange={(mode) => {
          setDisplayMode(mode);
          setTranscriptMemoryId(null);
          setOpened(null);
        }}
        hasMore={memories.hasNextPage ? !memories.isFetchNextPageError : false}
        loadingMore={memories.isFetchingNextPage}
        loadMoreFailed={memories.isFetchNextPageError}
        loadMore={() => {
          void memories.fetchNextPage();
        }}
        renderCard={({ memory, isActive }) => (
          <WorkspaceMemoryStackMemoryCard
            memory={memory}
            isActive={isActive}
            people={people}
            browserHref={browserHref}
            isBusy={isBusy}
            transcriptMemoryId={transcriptMemoryId}
            setTranscriptMemoryId={setTranscriptMemoryId}
            cardBrowser={cardBrowser}
            detailAction={detailAction}
          />
        )}
      >
        <MemoryVirtualList
          ref={virtualList}
          containerRef={memoryList}
          memories={rows}
          expandedId={opened?.id}
          detail={detail}
          focused={isTranscriptFocused}
          onOpen={onOpenMemory}
        />
      </MemoryCardBrowser>
      {memories.hasNextPage && displayMode === "list" ? (
        <MemoryLoadMore
          inert={isTranscriptFocused}
          loading={memories.isFetching}
          failed={memories.isFetchNextPageError}
          load={() => {
            void memories.fetchNextPage();
          }}
        />
      ) : null}
    </>
  );
}

function WorkspaceMemoryAllResultsEmpty({
  memories,
  processingMeeting,
}: {
  memories: UseInfiniteQueryResult<InfiniteData<MemoryListPage, string>>;
  processingMeeting: MemoryStatus["processingMeeting"];
}) {
  if (memories.hasNextPage) {
    return (
      <MemoryLoadMore
        loading={memories.isFetching}
        failed={memories.isFetchNextPageError}
        load={() => {
          void memories.fetchNextPage();
        }}
      />
    );
  }
  if (processingMeeting !== null && processingMeeting !== undefined) {
    return null;
  }

  return (
    <div className="workspace-task-empty-visual" role="status" aria-label={MESSAGE_MEMORY_NO_MEMORIES}>
      <MemoryAllNavIcon />
    </div>
  );
}

function WorkspaceMemoryAllResults({
  /** @external memory status wire field */
  processingMeeting,
  displayMode,
  isTranscriptFocused,
  memories,
  rows,
  cardBrowser,
  virtualList,
  memoryList,
  arrivals,
  opened,
  isForgetDialogOpen,
  isBusy,
  people,
  browserHref,
  detail,
  detailAction,
  transcriptMemoryId,
  setTranscriptMemoryId,
  setDisplayMode,
  setOpened,
  onOpenMemory,
  client,
  listOptions,
}: {
  /** @external memory status wire field */
  processingMeeting: MemoryStatus["processingMeeting"];
  displayMode: MemoryDisplayMode;
  isTranscriptFocused: boolean;
  memories: ReturnType<typeof useWorkspaceMemoryListQueries>["memories"];
  rows: RelationshipMemory[];
  cardBrowser: RefObject<MemoryCardBrowserHandle | null>;
  virtualList: RefObject<MemoryVirtualListHandle | null>;
  memoryList: RefObject<HTMLDivElement | null>;
  arrivals: ReturnType<typeof useMemoryArrivals>;
  opened: RelationshipMemory | null;
  isForgetDialogOpen: boolean;
  isBusy: boolean;
  people: ReturnType<typeof useWorkspaceMemoryListQueries>["people"];
  browserHref: string;
  detail: React.ReactNode;
  detailAction: (input: { action: "forget"; id: string }) => void;
  transcriptMemoryId: string | null;
  setTranscriptMemoryId: (id: string | null) => void;
  setDisplayMode: (mode: MemoryDisplayMode) => void;
  setOpened: (memory: RelationshipMemory | null) => void;
  onOpenMemory: (memory: RelationshipMemory) => void;
  client: ReturnType<typeof useQueryClient>;
  listOptions: ReturnType<typeof memoryListOptions>;
}) {
  return (
    <>
      {processingMeeting !== null && processingMeeting !== undefined && displayMode === "list" ? (
        <WorkspaceMemoryProcessingRow isTranscriptFocused={isTranscriptFocused} />
      ) : null}
      {memories.isPending ? null : memories.isError && memories.data === undefined ? (
        <p role="alert">
          {MESSAGE_MEMORY_MEMORIES_LOAD_FAILED}
          {MESSAGE_MEMORY_COPY_INLINE_SPACE}
          <button onClick={() => void memories.refetch()}>{MESSAGE_MEMORY_TRY_AGAIN}</button>
        </p>
      ) : rows.length === 0 ? (
        <WorkspaceMemoryAllResultsEmpty memories={memories} processingMeeting={processingMeeting} />
      ) : (
        <WorkspaceMemoryAllResultsBrowser
          memories={memories}
          rows={rows}
          cardBrowser={cardBrowser}
          virtualList={virtualList}
          memoryList={memoryList}
          arrivals={arrivals}
          opened={opened}
          isTranscriptFocused={isTranscriptFocused}
          isForgetDialogOpen={isForgetDialogOpen}
          isBusy={isBusy}
          people={people}
          browserHref={browserHref}
          detail={detail}
          detailAction={detailAction}
          transcriptMemoryId={transcriptMemoryId}
          setTranscriptMemoryId={setTranscriptMemoryId}
          setDisplayMode={setDisplayMode}
          setOpened={setOpened}
          onOpenMemory={onOpenMemory}
          displayMode={displayMode}
          client={client}
          listOptions={listOptions}
        />
      )}
    </>
  );
}

type WorkspaceMemoryPageLayoutProps = {
  view: "all" | "people";
  personId?: string;
  router: ReturnType<typeof useRouter>;
  backHref: string;
  isUpgradeRequired: boolean;
  isMemoryNavigationEnabled: boolean;
  status: ReturnType<typeof useMemoryStatus>;
  billing: ReturnType<typeof useTrialOffer>;
  error: string;
  person: ReturnType<typeof useWorkspaceMemoryPersonDetail>;
  personContent: React.ReactNode;
  opened: RelationshipMemory | null;
  isForgetDialogOpen: boolean;
  isBusy: boolean;
  isTranscriptFocused: boolean;
  closeMemory: () => void;
  openMemory: (memory: RelationshipMemory) => void;
  displayMode: MemoryDisplayMode;
  cardBrowser: RefObject<MemoryCardBrowserHandle | null>;
  setDisplayMode: (mode: MemoryDisplayMode) => void;
  memoryList: RefObject<HTMLDivElement | null>;
  virtualList: RefObject<MemoryVirtualListHandle | null>;
  browserHref: string;
  people: ReturnType<typeof useWorkspaceMemoryListQueries>["people"];
  pickerSearch: string | null;
  setPickerSearch: (value: string | null) => void;
  pickerPeople: ReturnType<typeof useWorkspaceMemoryListQueries>["pickerPeople"];
  changeFilters: (patch: Partial<BrowserFilters>) => void;
  onToolbarSearch: (query: string) => void;
  query: string;
  search: string;
  setQuery: (value: string) => void;
  category: string;
  personFilter: string;
  from: string;
  to: string;
  operators: { categoryOperator: string; personOperator: string; dateOperator: string };
  /** @external memory status wire field */
  processingMeeting: MemoryStatus["processingMeeting"];
  memories: ReturnType<typeof useWorkspaceMemoryListQueries>["memories"];
  rows: RelationshipMemory[];
  arrivals: ReturnType<typeof useMemoryArrivals>;
  client: ReturnType<typeof useQueryClient>;
  listOptions: ReturnType<typeof memoryListOptions>;
  filteredPeople: MemoryPerson[];
  detail: React.ReactNode;
  detailAction: (input: { action: "forget"; id: string }) => void;
  transcriptMemoryId: string | null;
  setTranscriptMemoryId: (id: string | null) => void;
  setOpened: (memory: RelationshipMemory | null) => void;
  forgetIds: string[];
  setIsForgetDialogOpen: (open: boolean) => void;
  act: (input: { action: "forget"; ids: string[] }) => Promise<void>;
  paymentStatus?: "processing" | "failed";
  token: string;
  workspaceId: string;
};

function WorkspaceMemoryPageToolbar({
  personId,
  displayMode,
  isTranscriptFocused,
  view,
  cardBrowser,
  setDisplayMode,
  pickerSearch,
  people,
  pickerPeople,
  setPickerSearch,
  category,
  personFilter,
  from,
  to,
  operators,
  changeFilters,
  query,
  search,
  setQuery,
  onToolbarSearch,
}: {
  personId?: string;
  displayMode: MemoryDisplayMode;
  isTranscriptFocused: boolean;
  view: "all" | "people";
  cardBrowser: RefObject<MemoryCardBrowserHandle | null>;
  setDisplayMode: (mode: MemoryDisplayMode) => void;
  pickerSearch: string | null;
  people: ReturnType<typeof useWorkspaceMemoryListQueries>["people"];
  pickerPeople: ReturnType<typeof useWorkspaceMemoryListQueries>["pickerPeople"];
  setPickerSearch: (value: string | null) => void;
  category: string;
  personFilter: string;
  from: string;
  to: string;
  operators: { categoryOperator: string; personOperator: string; dateOperator: string };
  changeFilters: (patch: Partial<BrowserFilters>) => void;
  query: string;
  search: string;
  setQuery: (value: string) => void;
  onToolbarSearch: (query: string) => void;
}) {
  if (personId !== undefined && personId !== "") {
    return null;
  }

  return (
    <MemoryBrowserToolbar
      inert={displayMode === "stack" ? isTranscriptFocused : false}
      layoutControl={
        view === "all" ? (
          <MemoryLayoutToggle
            mode={displayMode}
            onChange={(mode) => {
              if (cardBrowser.current) {
                cardBrowser.current.selectLayout(mode);
              } else {
                setDisplayMode(mode);
              }
            }}
          />
        ) : undefined
      }
      view={view}
      people={flattenMemoryPeoplePages(pickerSearch === null ? people.data : pickerPeople.data)}
      onPersonSearch={setPickerSearch}
      hasMorePeople={pickerPeople.hasNextPage}
      loadingPeople={pickerPeople.isFetching}
      onLoadMorePeople={() => {
        void pickerPeople.fetchNextPage();
      }}
      filters={{ category, person: personFilter, from, to, ...operators }}
      onChange={changeFilters}
      query={query}
      search={search}
      setQuery={setQuery}
      onSearch={onToolbarSearch}
    >
      <Link
        className="relationship-icon-button relationship-settings-button"
        href="/workspace/settings?tab=memory"
        aria-label={MESSAGE_MEMORY_SETTINGS_LINK}
      >
        <MemoryIcon name="settings" />
      </Link>
    </MemoryBrowserToolbar>
  );
}

type WorkspaceMemoryPageMainSectionProps = {
  status: ReturnType<typeof useMemoryStatus>;
  isMemoryNavigationEnabled: boolean;
  isUpgradeRequired: boolean;
  paymentStatus?: "processing" | "failed";
  token: string;
  workspaceId: string;
  hasPersonId: boolean;
  view: "all" | "people";
  personContent: React.ReactNode;
  person: ReturnType<typeof useWorkspaceMemoryPersonDetail>;
  rows: RelationshipMemory[];
  filteredPeople: MemoryPerson[];
  browserHref: string;
  displayMode: MemoryDisplayMode;
  cardBrowser: RefObject<MemoryCardBrowserHandle | null>;
  setDisplayMode: (mode: MemoryDisplayMode) => void;
  arrivals: ReturnType<typeof useMemoryArrivals>;
  processingMeeting: MemoryStatus["processingMeeting"];
  isTranscriptFocused: boolean;
  memories: UseInfiniteQueryResult<InfiniteData<MemoryListPage, string>>;
  virtualList: RefObject<MemoryVirtualListHandle | null>;
  memoryList: RefObject<HTMLDivElement | null>;
  opened: RelationshipMemory | null;
  isForgetDialogOpen: boolean;
  isBusy: boolean;
  people: ReturnType<typeof useWorkspaceMemoryListQueries>["people"];
  detail: React.ReactNode;
  detailAction: (input: { action: "forget"; id: string }) => void;
  transcriptMemoryId: string | null;
  setTranscriptMemoryId: (id: string | null) => void;
  setOpened: (memory: RelationshipMemory | null) => void;
  openMemory: (memory: RelationshipMemory) => void;
  client: ReturnType<typeof useQueryClient>;
  listOptions: ReturnType<typeof memoryListOptions>;
  personId?: string;
};

function readWorkspaceMemoryNavigationStatus(input: {
  status: ReturnType<typeof useMemoryStatus>;
  isMemoryNavigationEnabled: boolean;
}): React.ReactNode | null {
  if (input.status.isPending && !input.isMemoryNavigationEnabled) {
    return (
      <p className="workspace-loading-status" role="status">
        {MESSAGE_MEMORY_LOADING}
      </p>
    );
  }
  if (input.status.isError && !input.isMemoryNavigationEnabled) {
    return (
      <p role="alert">
        {MESSAGE_MEMORY_LOAD_FAILED}
        {MESSAGE_MEMORY_COPY_INLINE_SPACE}
        <button onClick={() => void input.status.refetch()}>{MESSAGE_MEMORY_TRY_AGAIN}</button>
      </p>
    );
  }
  if (!input.isMemoryNavigationEnabled) {
    return <p>{MESSAGE_MEMORY_UNAVAILABLE}</p>;
  }

  return null;
}

function WorkspaceMemoryPageUpgradeSection(
  props: Pick<
    WorkspaceMemoryPageMainSectionProps,
    | "paymentStatus"
    | "token"
    | "workspaceId"
    | "hasPersonId"
    | "view"
    | "personContent"
    | "person"
    | "rows"
    | "filteredPeople"
    | "browserHref"
    | "displayMode"
    | "cardBrowser"
    | "setDisplayMode"
    | "arrivals"
  >,
) {
  const {
    paymentStatus,
    token,
    workspaceId,
    hasPersonId,
    view,
    personContent,
    person,
    rows,
    filteredPeople,
    browserHref,
    displayMode,
    cardBrowser,
    setDisplayMode,
    arrivals,
  } = props;

  return (
    <MemoryUpgradeGate
      paymentStatus={paymentStatus}
      token={token}
      workspaceId={workspaceId}
      view={hasPersonId ? "person" : view}
      personContent={personContent}
      memories={hasPersonId ? (person.data?.memories ?? []) : rows}
      people={filteredPeople}
      returnTo={browserHref}
      displayMode={displayMode}
      browserRef={hasPersonId ? undefined : cardBrowser}
      onModeChange={setDisplayMode}
      arrivals={arrivals}
    />
  );
}

function WorkspaceMemoryPageResultsSection(props: WorkspaceMemoryPageMainSectionProps) {
  const {
    view,
    personId,
    hasPersonId,
    processingMeeting,
    displayMode,
    isTranscriptFocused,
    memories,
    rows,
    cardBrowser,
    virtualList,
    memoryList,
    arrivals,
    opened,
    isForgetDialogOpen,
    isBusy,
    people,
    browserHref,
    detail,
    detailAction,
    transcriptMemoryId,
    setTranscriptMemoryId,
    setDisplayMode,
    setOpened,
    openMemory,
    client,
    listOptions,
    filteredPeople,
    personContent,
  } = props;

  return (
    <div data-memory-results>
      {view === "all" ? (
        <WorkspaceMemoryAllResults
          processingMeeting={processingMeeting}
          displayMode={displayMode}
          isTranscriptFocused={isTranscriptFocused}
          memories={memories}
          rows={rows}
          cardBrowser={cardBrowser}
          virtualList={virtualList}
          memoryList={memoryList}
          arrivals={arrivals}
          opened={opened}
          isForgetDialogOpen={isForgetDialogOpen}
          isBusy={isBusy}
          people={people}
          browserHref={browserHref}
          detail={detail}
          detailAction={detailAction}
          transcriptMemoryId={transcriptMemoryId}
          setTranscriptMemoryId={setTranscriptMemoryId}
          setDisplayMode={setDisplayMode}
          setOpened={setOpened}
          onOpenMemory={openMemory}
          client={client}
          listOptions={listOptions}
        />
      ) : null}
      {view === "people" && (personId === undefined || personId === "") ? (
        <WorkspaceMemoryPeopleResults people={people} filteredPeople={filteredPeople} browserHref={browserHref} />
      ) : null}
      {hasPersonId && opened !== null ? detail : null}
      {hasPersonId && opened === null ? personContent : null}
    </div>
  );
}

function WorkspaceMemoryPageMainSection(props: WorkspaceMemoryPageMainSectionProps): React.ReactNode {
  const { status, isMemoryNavigationEnabled, isUpgradeRequired } = props;
  const navigationStatus = readWorkspaceMemoryNavigationStatus({ status, isMemoryNavigationEnabled });
  if (navigationStatus !== null) {
    return navigationStatus;
  }
  if (isUpgradeRequired) {
    return <WorkspaceMemoryPageUpgradeSection {...props} />;
  }

  return <WorkspaceMemoryPageResultsSection {...props} />;
}

function WorkspaceMemoryPageBackNavigation({
  hasPersonId,
  person,
  view,
  opened,
  isTranscriptFocused,
  backHref,
  closeMemory,
}: {
  hasPersonId: boolean;
  person: ReturnType<typeof useWorkspaceMemoryPersonDetail>;
  view: "all" | "people";
  opened: RelationshipMemory | null;
  isTranscriptFocused: boolean;
  backHref: string;
  closeMemory: () => void;
}) {
  return (
    <>
      <h1 className="relationship-sr-only">
        {hasPersonId
          ? (person.data?.person.name ?? MESSAGE_MEMORY_PERSON_FALLBACK)
          : view === "people"
            ? MESSAGE_MEMORY_PEOPLE_NAV
            : MESSAGE_MEMORY_ALL_NAV}
      </h1>
      {hasPersonId && opened !== null ? (
        <button
          className="relationship-memory-back"
          aria-label={MESSAGE_MEMORY_BACK}
          inert={isTranscriptFocused}
          onClick={closeMemory}
        >
          <span className="workspace-category-item-main">
            <MemoryIcon name="back" />
            <span>{MESSAGE_MEMORY_BACK}</span>
          </span>
          <CalendarChevronIcon />
        </button>
      ) : null}
      {hasPersonId && opened === null ? (
        <Link className="relationship-memory-back" href={backHref} aria-label={MESSAGE_MEMORY_BACK}>
          <span className="workspace-category-item-main">
            <MemoryIcon name="back" />
            <span>{MESSAGE_MEMORY_BACK}</span>
          </span>
          <CalendarChevronIcon />
        </Link>
      ) : null}
    </>
  );
}

function WorkspaceMemoryPageOverlays({
  billing,
  isForgetDialogOpen,
  isBusy,
  forgetIds,
  setIsForgetDialogOpen,
  act,
}: {
  billing: ReturnType<typeof useTrialOffer>;
  isForgetDialogOpen: boolean;
  isBusy: boolean;
  forgetIds: string[];
  setIsForgetDialogOpen: (open: boolean) => void;
  act: (input: { action: "forget"; ids: string[] }) => Promise<void>;
}) {
  return (
    <>
      {billing.isError && !billing.hasKnownPlan ? (
        <p role="alert">
          {MESSAGE_MEMORY_PLAN_CHECK_FAILED}
          {MESSAGE_MEMORY_COPY_INLINE_SPACE}
          <button onClick={() => void billing.refetch()}>{MESSAGE_MEMORY_TRY_AGAIN}</button>
        </p>
      ) : null}
      {isForgetDialogOpen ? (
        <ForgetDialog
          isBusy={isBusy}
          onCancel={() => setIsForgetDialogOpen(false)}
          onConfirm={() => void act({ action: "forget", ids: forgetIds })}
        />
      ) : null}
    </>
  );
}

function WorkspaceMemoryPageStack(props: WorkspaceMemoryPageState & { hasPersonId: boolean }) {
  return (
    <>
      <WorkspaceMemoryPageBackNavigation
        hasPersonId={props.hasPersonId}
        person={props.person}
        view={props.view}
        opened={props.opened}
        isTranscriptFocused={props.isTranscriptFocused}
        backHref={props.backHref}
        closeMemory={props.closeMemory}
      />
      {props.error !== "" ? (
        <p role="alert" className="relationship-memory-error">
          {props.error}
        </p>
      ) : null}
      <WorkspaceMemoryPageToolbar
        personId={props.personId}
        displayMode={props.displayMode}
        isTranscriptFocused={props.isTranscriptFocused}
        view={props.view}
        cardBrowser={props.cardBrowser}
        setDisplayMode={props.setDisplayMode}
        pickerSearch={props.pickerSearch}
        people={props.people}
        pickerPeople={props.pickerPeople}
        setPickerSearch={props.setPickerSearch}
        category={props.category}
        personFilter={props.personFilter}
        from={props.from}
        to={props.to}
        operators={props.operators}
        changeFilters={props.changeFilters}
        query={props.query}
        search={props.search}
        setQuery={props.setQuery}
        onToolbarSearch={props.onToolbarSearch}
      />
      <WorkspaceMemoryPageMainSection {...props} />
      <WorkspaceMemoryPageOverlays
        billing={props.billing}
        isForgetDialogOpen={props.isForgetDialogOpen}
        isBusy={props.isBusy}
        forgetIds={props.forgetIds}
        setIsForgetDialogOpen={props.setIsForgetDialogOpen}
        act={props.act}
      />
    </>
  );
}

function WorkspaceMemoryPageLayout(props: WorkspaceMemoryPageState) {
  const {
    view,
    personId,
    router,
    backHref,
    isUpgradeRequired,
    isForgetDialogOpen,
    opened,
    isTranscriptFocused,
    closeMemory,
  } = props;
  const hasPersonId = personId !== undefined && personId !== "";

  return (
    <WorkspaceShell
      meetings={[]}
      activeSidebarView={view === "people" ? "memory-people" : "memory-all"}
      contentClassName={`relationship-memory-content${hasPersonId && !isUpgradeRequired ? "" : " relationship-memory-list-content"}`}
    >
      <section
        aria-label={MESSAGE_MEMORY_BROWSER_LABEL}
        className={`relationship-memory-page${hasPersonId ? " is-person-page" : ""}${isTranscriptFocused ? " is-focused-memory" : ""}`}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !isForgetDialogOpen) {
            if (opened) {
              closeMemory();
            } else if (hasPersonId) {
              router.push(backHref);
            }
          }
        }}
      >
        <WorkspaceMemoryPageStack {...props} hasPersonId={hasPersonId} />
      </section>
    </WorkspaceShell>
  );
}

function buildWorkspaceMemoryBrowserHref(input: {
  view: "all" | "people";
  search: string;
  operators: { categoryOperator: string; personOperator: string; dateOperator: string };
  category: string;
  personFilter: string;
  from: string;
  to: string;
}): string {
  const browserParams = new URLSearchParams();
  Object.entries({
    q: input.search,
    ...input.operators,
    category: input.category,
    person: input.personFilter,
    from: input.from,
    to: input.to,
  }).forEach(([key, value]) => {
    if (value !== "") {
      browserParams.set(key, value);
    }
  });

  return `/workspace/memory${input.view === "people" ? "/people" : ""}${browserParams.size > 0 ? `?${browserParams}` : ""}`;
}

function readWorkspaceMemoryBackHref(requestedReturn: string | null): string {
  if (
    requestedReturn !== null &&
    requestedReturn !== "" &&
    /^\/workspace\/memory(?:\/people)?(?:\?|$)/.test(requestedReturn)
  ) {
    return requestedReturn;
  }

  return "/workspace/memory/people";
}

async function forgetWorkspaceMemories(input: {
  token: string;
  workspaceId: string;
  key: ReturnType<typeof useMemorySession>["key"];
  client: ReturnType<typeof useQueryClient>;
  ids: string[];
  opened: RelationshipMemory | null;
  closeMemory: () => void;
  setIsBusy: (busy: boolean) => void;
  setError: (message: string) => void;
  setIsForgetDialogOpen: (open: boolean) => void;
}) {
  input.setIsBusy(true);
  input.setError("");
  try {
    await updateMemories({ token: input.token, workspaceId: input.workspaceId, ids: input.ids, action: "forget" });
    await removeForgottenMemories({ client: input.client, scope: input.key, ids: input.ids });
    broadcastMemoryForget({ userId: input.key[1] ?? "", workspaceId: input.workspaceId, ids: input.ids });
    input.setIsForgetDialogOpen(false);
    if (input.opened !== null && input.ids.includes(input.opened.id)) {
      input.closeMemory();
    }
    await input.client.invalidateQueries({ queryKey: input.key });
  } catch (e) {
    input.setError(getApiErrorMessage({ error: e, fallback: MESSAGE_MEMORY_UPDATE_FAILED }));
  } finally {
    input.setIsBusy(false);
  }
}

type WorkspaceMemoryPageState = WorkspaceMemoryPageLayoutProps & {
  view: "all" | "people";
  personId?: string;
  router: ReturnType<typeof useRouter>;
};

function createWorkspaceMemoryBrowserControls(input: {
  view: "all" | "people";
  personId?: string;
  opener: RefObject<HTMLElement | null>;
  setOpened: (memory: RelationshipMemory | null) => void;
  setTranscriptMemoryId: (id: string | null) => void;
  setOperators: React.Dispatch<
    React.SetStateAction<{ categoryOperator: string; personOperator: string; dateOperator: string }>
  >;
  setCategory: (value: string) => void;
  setPersonFilter: (value: string) => void;
  setFrom: (value: string) => void;
  setTo: (value: string) => void;
}) {
  const {
    view,
    personId,
    opener,
    setOpened,
    setTranscriptMemoryId,
    setOperators,
    setCategory,
    setPersonFilter,
    setFrom,
    setTo,
  } = input;
  function updateBrowserUrl(patch: Record<string, string>) {
    const path = `/workspace/memory${view === "people" ? "/people" : ""}`;
    if (Boolean(personId) || window.location.pathname !== path) {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    params.delete("state");
    params.delete("memory");
    Object.entries(patch).forEach(([key, value]) => {
      if (value !== "") {
        params.set(key, value);
      } else {
        params.delete(key);
      }
    });
    window.history.replaceState(window.history.state, "", `${path}${params.size > 0 ? `?${params}` : ""}`);
  }
  function changeFilters(patch: Partial<BrowserFilters>) {
    updateBrowserUrl({
      ...patch,
      ...(patch.category === "" ? { categoryOperator: "is" } : {}),
      ...(patch.person === "" ? { personOperator: "is" } : {}),
      ...(patch.from === "" && patch.to === "" ? { dateOperator: "is" } : {}),
    });
    setOperators((previous) => ({
      categoryOperator: patch.categoryOperator ?? (patch.category === "" ? "is" : previous.categoryOperator),
      personOperator: patch.personOperator ?? (patch.person === "" ? "is" : previous.personOperator),
      dateOperator: patch.dateOperator ?? (patch.from === "" && patch.to === "" ? "is" : previous.dateOperator),
    }));
    if (patch.category !== undefined) {
      setCategory(patch.category);
    }
    if (patch.person !== undefined) {
      setPersonFilter(patch.person);
    }
    if (patch.from !== undefined) {
      setFrom(patch.from);
    }
    if (patch.to !== undefined) {
      setTo(patch.to);
    }
    setTranscriptMemoryId(null);
    setOpened(null);
  }
  function openMemory(memory: RelationshipMemory) {
    updateBrowserUrl({});
    opener.current = readActiveHTMLElement();
    setTranscriptMemoryId(null);
    setOpened(memory);
  }
  function closeMemory() {
    updateBrowserUrl({});
    const label = opener.current?.getAttribute("aria-label");
    setTranscriptMemoryId(null);
    setOpened(null);
    requestAnimationFrame(() => {
      const target =
        opener.current?.isConnected === true
          ? opener.current
          : [...document.querySelectorAll<HTMLElement>("[aria-label]")].find(
              (node) => node.getAttribute("aria-label") === label,
            );
      target?.focus({ preventScroll: true });
    });
  }

  return { updateBrowserUrl, changeFilters, openMemory, closeMemory };
}

function useWorkspaceMemoryDismissOutsideOpen(input: {
  opened: RelationshipMemory | null;
  isForgetDialogOpen: boolean;
  personId?: string;
  memoryList: RefObject<HTMLDivElement | null>;
  updateBrowserUrl: (patch: Record<string, string>) => void;
  setTranscriptMemoryId: (id: string | null) => void;
  setOpened: (memory: RelationshipMemory | null) => void;
}) {
  useEffect(() => {
    if (input.opened === null || input.isForgetDialogOpen || Boolean(input.personId)) {
      return;
    }
    function dismissOutsideList(event: MouseEvent) {
      if (!(event.target instanceof Node) || input.memoryList.current?.contains(event.target) === true) {
        return;
      }
      input.updateBrowserUrl({});
      input.setTranscriptMemoryId(null);
      input.setOpened(null);
    }
    document.addEventListener("click", dismissOutsideList, true);

    return () => document.removeEventListener("click", dismissOutsideList, true);
  });
}

function useWorkspaceMemoryPageQueryBundle(input: {
  client: ReturnType<typeof useQueryClient>;
  token: string;
  workspaceId: string;
  key: ReturnType<typeof useMemorySession>["key"];
  view: "all" | "people";
  search: string;
  category: string;
  from: string;
  to: string;
  operators: { categoryOperator: string; personOperator: string; dateOperator: string };
  personFilter: string;
  isMemoryNavigationEnabled: boolean;
  personId?: string;
  opened: RelationshipMemory | null;
  setOpened: (memory: RelationshipMemory | null) => void;
  setTranscriptMemoryId: (id: string | null) => void;
  setError: (message: string) => void;
  requestedMemoryId: string | null;
  handledMemoryLink: RefObject<string | null>;
  memoryLinkSearch: RefObject<string | null>;
  scrollToMemory: RefObject<string | null>;
  virtualList: RefObject<MemoryVirtualListHandle | null>;
}) {
  const { filters, listOptions, memories, people, pickerSearch, setPickerSearch, pickerPeople, filteredPeople } =
    useWorkspaceMemoryListQueries({
      client: input.client,
      token: input.token,
      workspaceId: input.workspaceId,
      key: input.key,
      view: input.view,
      search: input.search,
      category: input.category,
      from: input.from,
      to: input.to,
      operators: input.operators,
      personFilter: input.personFilter,
      isMemoryNavigationEnabled: input.isMemoryNavigationEnabled,
    });
  const person = useWorkspaceMemoryPersonDetail({
    key: input.key,
    token: input.token,
    workspaceId: input.workspaceId,
    personId: input.personId,
    isMemoryNavigationEnabled: input.isMemoryNavigationEnabled,
  });
  const rows = useMemo(() => flattenMemoryListPages(memories.data), [memories.data]);
  const arrivals = useMemoryArrivals({
    memories: rows,
    scope: JSON.stringify([...input.key, filters]),
    ready: memories.isSuccess && !memories.isPlaceholderData,
    pageCount: readMemoryListPageCount(memories.data),
    pageWindow: JSON.stringify(memories.data?.pageParams ?? []),
  });
  const standingIds = new Set(person.data?.projection?.standing.flatMap((item) => item.memoryIds));
  const standingMemories = (person.data?.memories ?? [])
    .filter((memory) => standingIds.has(memory.id))
    .sort(compareRelationshipMemories);
  useWorkspaceMemoryResultEffects({
    personId: input.personId,
    view: input.view,
    opened: input.opened,
    setOpened: input.setOpened,
    setTranscriptMemoryId: input.setTranscriptMemoryId,
    rows,
    memories,
    isMemoryNavigationEnabled: input.isMemoryNavigationEnabled,
    requestedMemoryId: input.requestedMemoryId,
    handledMemoryLink: input.handledMemoryLink,
    memoryLinkSearch: input.memoryLinkSearch,
    scrollToMemory: input.scrollToMemory,
    setError: input.setError,
    listOptions,
    client: input.client,
    virtualList: input.virtualList,
  });

  return {
    filters,
    listOptions,
    memories,
    people,
    pickerSearch,
    setPickerSearch,
    pickerPeople,
    filteredPeople,
    person,
    rows,
    arrivals,
    standingMemories,
  };
}

function applyWorkspaceMemoryPersonRouteTransition(input: {
  personId?: string;
  previousPersonId?: string;
  searchParams: ReturnType<typeof useSearchParams>;
  setPreviousPersonId: (personId?: string) => void;
  setOpened: (memory: RelationshipMemory | null) => void;
  setTranscriptMemoryId: (id: string | null) => void;
  setIsForgetDialogOpen: (open: boolean) => void;
  setError: (message: string) => void;
  setQuery: (value: string) => void;
  setSearch: (value: string) => void;
  setCategory: (value: string) => void;
  setFrom: (value: string) => void;
  setTo: (value: string) => void;
  setPersonFilter: (value: string) => void;
  setOperators: React.Dispatch<
    React.SetStateAction<{ categoryOperator: string; personOperator: string; dateOperator: string }>
  >;
}) {
  if (input.previousPersonId === input.personId) {
    return;
  }
  input.setPreviousPersonId(input.personId);
  input.setOpened(null);
  input.setTranscriptMemoryId(null);
  input.setIsForgetDialogOpen(false);
  input.setError("");
  if (input.personId === undefined || input.personId === "") {
    input.setQuery(input.searchParams.get("q") ?? "");
    input.setSearch(input.searchParams.get("q") ?? "");
    input.setCategory(normalizeMemoryCategory(input.searchParams.get("category") ?? ""));
    input.setFrom(validDate(input.searchParams.get("from")));
    input.setTo(validDate(input.searchParams.get("to")));
    input.setPersonFilter(input.searchParams.get("person") ?? "");
    input.setOperators({
      categoryOperator: input.searchParams.get("categoryOperator") === "is_not" ? "is_not" : "is",
      personOperator: input.searchParams.get("personOperator") === "is_not" ? "is_not" : "is",
      dateOperator: input.searchParams.get("dateOperator") === "is_not" ? "is_not" : "is",
    });
  }
}

function readWorkspaceMemoryUpgradeRequired(input: {
  billing: ReturnType<typeof useTrialOffer>;
  paymentStatus?: "processing" | "failed";
}): boolean {
  return (
    input.billing.hasKnownPlan &&
    (input.paymentStatus === "processing" ||
      (input.billing.data?.plan === "free" && !input.billing.data.subscriptionActive))
  );
}

function buildWorkspaceMemoryPageState(input: WorkspaceMemoryPageState): WorkspaceMemoryPageState {
  return input;
}

function readWorkspaceMemoryPagePanels(input: {
  personId?: string;
  person: ReturnType<typeof useWorkspaceMemoryPersonDetail>;
  standingMemories: RelationshipMemory[];
  opened: RelationshipMemory | null;
  people: ReturnType<typeof useWorkspaceMemoryListQueries>["people"];
  browserHref: string;
  isBusy: boolean;
  isTranscriptFocused: boolean;
  setTranscriptMemoryId: (id: string | null) => void;
  closeMemory: () => void;
  setForgetIds: (ids: string[]) => void;
  setIsForgetDialogOpen: (open: boolean) => void;
}) {
  function detailAction(forgetInput: { action: "forget"; id: string }) {
    input.setForgetIds([forgetInput.id]);
    input.setIsForgetDialogOpen(true);
  }
  const personContent =
    input.personId !== undefined && input.personId !== "" ? (
      <WorkspaceMemoryPersonPanel
        personId={input.personId}
        person={input.person}
        standingMemories={input.standingMemories}
      />
    ) : null;
  const detail = input.opened && (
    <MemoryDetail
      key={input.opened.id}
      memory={input.opened}
      people={flattenMemoryPeoplePages(input.people.data)}
      returnTo={
        input.personId !== undefined && input.personId !== ""
          ? `/workspace/memory/people/${input.personId}`
          : input.browserHref
      }
      isBusy={input.isBusy}
      isTranscriptOpen={input.isTranscriptFocused}
      onTranscriptChange={({ isOpen }) => input.setTranscriptMemoryId(isOpen ? (input.opened?.id ?? null) : null)}
      onClose={input.closeMemory}
      onAction={detailAction}
    />
  );

  return { personContent, detail, detailAction };
}

function useWorkspaceMemoryUrlFilterState(searchParams: ReturnType<typeof useSearchParams>) {
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [category, setCategory] = useState(normalizeMemoryCategory(searchParams.get("category") ?? ""));
  const [from, setFrom] = useState(validDate(searchParams.get("from")));
  const [to, setTo] = useState(validDate(searchParams.get("to")));
  const [personFilter, setPersonFilter] = useState(searchParams.get("person") ?? "");
  const [operators, setOperators] = useState({
    categoryOperator: searchParams.get("categoryOperator") === "is_not" ? "is_not" : "is",
    personOperator: searchParams.get("personOperator") === "is_not" ? "is_not" : "is",
    dateOperator: searchParams.get("dateOperator") === "is_not" ? "is_not" : "is",
  });

  return {
    query,
    setQuery,
    search,
    setSearch,
    category,
    setCategory,
    from,
    setFrom,
    to,
    setTo,
    personFilter,
    setPersonFilter,
    operators,
    setOperators,
  };
}

function useWorkspaceMemoryOpenSelectionState() {
  const [transcriptMemoryId, setTranscriptMemoryId] = useState<string | null>(null);
  const [opened, setOpened] = useState<RelationshipMemory | null>(null);
  const [isForgetDialogOpen, setIsForgetDialogOpen] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");

  return {
    transcriptMemoryId,
    setTranscriptMemoryId,
    opened,
    setOpened,
    isForgetDialogOpen,
    setIsForgetDialogOpen,
    isBusy,
    setIsBusy,
    error,
    setError,
  };
}

function useWorkspaceMemoryPageData(input: {
  client: ReturnType<typeof useQueryClient>;
  token: string;
  workspaceId: string;
  key: ReturnType<typeof useMemorySession>["key"];
  status: ReturnType<typeof useMemoryStatus>;
  view: "all" | "people";
  personId?: string;
  filters: ReturnType<typeof useWorkspaceMemoryUrlFilterState>;
  selection: ReturnType<typeof useWorkspaceMemoryOpenSelectionState>;
  isMemoryNavigationEnabled: boolean;
  requestedMemoryId: string | null;
  handledMemoryLink: RefObject<string | null>;
  memoryLinkSearch: RefObject<string | null>;
  scrollToMemory: RefObject<string | null>;
  virtualList: RefObject<MemoryVirtualListHandle | null>;
  browserHref: string;
  closeMemory: () => void;
  updateBrowserUrl: (patch: Record<string, string>) => void;
  setForgetIds: (ids: string[]) => void;
  isTranscriptFocused: boolean;
}) {
  const queryBundle = useWorkspaceMemoryPageQueryBundle({
    client: input.client,
    token: input.token,
    workspaceId: input.workspaceId,
    key: input.key,
    view: input.view,
    search: input.filters.search,
    category: input.filters.category,
    from: input.filters.from,
    to: input.filters.to,
    operators: input.filters.operators,
    personFilter: input.filters.personFilter,
    isMemoryNavigationEnabled: input.isMemoryNavigationEnabled,
    personId: input.personId,
    opened: input.selection.opened,
    setOpened: input.selection.setOpened,
    setTranscriptMemoryId: input.selection.setTranscriptMemoryId,
    setError: input.selection.setError,
    requestedMemoryId: input.requestedMemoryId,
    handledMemoryLink: input.handledMemoryLink,
    memoryLinkSearch: input.memoryLinkSearch,
    scrollToMemory: input.scrollToMemory,
    virtualList: input.virtualList,
  });
  const progress = input.status.data?.progress;
  useMemoryFailureToast({
    token: input.token,
    workspaceId: input.workspaceId,
    userId: input.key[1],
    failures: (progress?.failed ?? 0) + (progress?.projectionFailed ?? 0),
  });
  /** @external memory status wire field */
  const processingMeeting = input.status.data?.processingMeeting;
  async function act(forgetInput: { action: "forget"; ids: string[] }) {
    await forgetWorkspaceMemories({
      token: input.token,
      workspaceId: input.workspaceId,
      key: input.key,
      client: input.client,
      ids: forgetInput.ids,
      opened: input.selection.opened,
      closeMemory: input.closeMemory,
      setIsBusy: input.selection.setIsBusy,
      setError: input.selection.setError,
      setIsForgetDialogOpen: input.selection.setIsForgetDialogOpen,
    });
  }
  const panels = readWorkspaceMemoryPagePanels({
    personId: input.personId,
    person: queryBundle.person,
    standingMemories: queryBundle.standingMemories,
    opened: input.selection.opened,
    people: queryBundle.people,
    browserHref: input.browserHref,
    isBusy: input.selection.isBusy,
    isTranscriptFocused: input.isTranscriptFocused,
    setTranscriptMemoryId: input.selection.setTranscriptMemoryId,
    closeMemory: input.closeMemory,
    setForgetIds: input.setForgetIds,
    setIsForgetDialogOpen: input.selection.setIsForgetDialogOpen,
  });
  function onToolbarSearch(searchQuery: string) {
    input.updateBrowserUrl({ q: searchQuery });
    input.filters.setSearch(searchQuery);
    input.selection.setTranscriptMemoryId(null);
    input.selection.setOpened(null);
  }

  return { ...queryBundle, processingMeeting, act, ...panels, onToolbarSearch };
}

function assembleWorkspaceMemoryPageState(input: {
  view: "all" | "people";
  personId?: string;
  router: ReturnType<typeof useRouter>;
  backHref: string;
  isUpgradeRequired: boolean;
  isMemoryNavigationEnabled: boolean;
  status: ReturnType<typeof useMemoryStatus>;
  billing: ReturnType<typeof useTrialOffer>;
  selection: ReturnType<typeof useWorkspaceMemoryOpenSelectionState>;
  filters: ReturnType<typeof useWorkspaceMemoryUrlFilterState>;
  pageData: ReturnType<typeof useWorkspaceMemoryPageData>;
  isTranscriptFocused: boolean;
  closeMemory: () => void;
  openMemory: (memory: RelationshipMemory) => void;
  displayMode: MemoryDisplayMode;
  cardBrowser: RefObject<MemoryCardBrowserHandle | null>;
  setDisplayMode: (mode: MemoryDisplayMode) => void;
  memoryList: RefObject<HTMLDivElement | null>;
  virtualList: RefObject<MemoryVirtualListHandle | null>;
  browserHref: string;
  changeFilters: (patch: Partial<BrowserFilters>) => void;
  forgetIds: string[];
  paymentStatus?: "processing" | "failed";
  token: string;
  workspaceId: string;
  client: ReturnType<typeof useQueryClient>;
}): WorkspaceMemoryPageState {
  return buildWorkspaceMemoryPageState({
    view: input.view,
    personId: input.personId,
    router: input.router,
    backHref: input.backHref,
    isUpgradeRequired: input.isUpgradeRequired,
    isMemoryNavigationEnabled: input.isMemoryNavigationEnabled,
    status: input.status,
    billing: input.billing,
    error: input.selection.error,
    person: input.pageData.person,
    personContent: input.pageData.personContent,
    opened: input.selection.opened,
    isForgetDialogOpen: input.selection.isForgetDialogOpen,
    isBusy: input.selection.isBusy,
    isTranscriptFocused: input.isTranscriptFocused,
    closeMemory: input.closeMemory,
    openMemory: input.openMemory,
    displayMode: input.displayMode,
    cardBrowser: input.cardBrowser,
    setDisplayMode: input.setDisplayMode,
    memoryList: input.memoryList,
    virtualList: input.virtualList,
    browserHref: input.browserHref,
    people: input.pageData.people,
    pickerSearch: input.pageData.pickerSearch,
    setPickerSearch: input.pageData.setPickerSearch,
    pickerPeople: input.pageData.pickerPeople,
    changeFilters: input.changeFilters,
    onToolbarSearch: input.pageData.onToolbarSearch,
    query: input.filters.query,
    search: input.filters.search,
    setQuery: input.filters.setQuery,
    category: input.filters.category,
    personFilter: input.filters.personFilter,
    from: input.filters.from,
    to: input.filters.to,
    operators: input.filters.operators,
    processingMeeting: input.pageData.processingMeeting,
    memories: input.pageData.memories,
    rows: input.pageData.rows,
    arrivals: input.pageData.arrivals,
    client: input.client,
    listOptions: input.pageData.listOptions,
    filteredPeople: input.pageData.filteredPeople,
    detail: input.pageData.detail,
    detailAction: input.pageData.detailAction,
    transcriptMemoryId: input.selection.transcriptMemoryId,
    setTranscriptMemoryId: input.selection.setTranscriptMemoryId,
    setOpened: input.selection.setOpened,
    forgetIds: input.forgetIds,
    setIsForgetDialogOpen: input.selection.setIsForgetDialogOpen,
    act: input.pageData.act,
    paymentStatus: input.paymentStatus,
    token: input.token,
    workspaceId: input.workspaceId,
  });
}

function useWorkspaceMemoryPageBrowserEffects(input: {
  view: "all" | "people";
  personId?: string;
  opener: RefObject<HTMLElement | null>;
  selection: ReturnType<typeof useWorkspaceMemoryOpenSelectionState>;
  filters: ReturnType<typeof useWorkspaceMemoryUrlFilterState>;
  memoryList: RefObject<HTMLDivElement | null>;
  isMemoryNavigationEnabled: boolean;
}) {
  const browserControls = createWorkspaceMemoryBrowserControls({
    view: input.view,
    personId: input.personId,
    opener: input.opener,
    setOpened: input.selection.setOpened,
    setTranscriptMemoryId: input.selection.setTranscriptMemoryId,
    setOperators: input.filters.setOperators,
    setCategory: input.filters.setCategory,
    setPersonFilter: input.filters.setPersonFilter,
    setFrom: input.filters.setFrom,
    setTo: input.filters.setTo,
  });
  useWorkspaceMemoryDismissOutsideOpen({
    opened: input.selection.opened,
    isForgetDialogOpen: input.selection.isForgetDialogOpen,
    personId: input.personId,
    memoryList: input.memoryList,
    updateBrowserUrl: browserControls.updateBrowserUrl,
    setTranscriptMemoryId: input.selection.setTranscriptMemoryId,
    setOpened: input.selection.setOpened,
  });
  useEffect(() => {
    if (!input.isMemoryNavigationEnabled) {
      input.selection.setOpened(null);
    }
  }, [input.isMemoryNavigationEnabled, input.selection.setOpened]);

  return browserControls;
}

function useWorkspaceMemoryPageChrome(input: { view: "all" | "people"; personId?: string }) {
  const { token, workspaceId, key } = useMemorySession();
  const status = useMemoryStatus();
  const client = useQueryClient();
  const billing = useTrialOffer(token, workspaceId);
  const paymentStatus = billing.data?.checkout?.kind === "subscription" ? billing.data.checkout.status : undefined;
  const isUpgradeRequired = readWorkspaceMemoryUpgradeRequired({ billing, paymentStatus });
  const { session } = useAuth();
  const isMemoryNavigationEnabled = canShowMemoryNavigation({
    user: session?.user,
    isStatusAvailable: status.data?.available,
  });
  const searchParams = useSearchParams();
  const router = useRouter();
  const opener = useRef<HTMLElement | null>(null);
  const memoryList = useRef<HTMLDivElement | null>(null);
  const virtualList = useRef<MemoryVirtualListHandle | null>(null);
  const cardBrowser = useRef<MemoryCardBrowserHandle>(null);
  const [displayMode, setDisplayMode] = useState<MemoryDisplayMode>("list");
  const handledMemoryLink = useRef<string | null>(null);
  const memoryLinkSearch = useRef<string | null>(null);
  const scrollToMemory = useRef<string | null>(null);
  const requestedMemoryId = searchParams.get("memory");
  const [forgetIds, setForgetIds] = useState<string[]>([]);
  const filters = useWorkspaceMemoryUrlFilterState(searchParams);
  const selection = useWorkspaceMemoryOpenSelectionState();
  const [previousPersonId, setPreviousPersonId] = useState(input.personId);
  applyWorkspaceMemoryPersonRouteTransition({
    personId: input.personId,
    previousPersonId,
    searchParams,
    setPreviousPersonId,
    setOpened: selection.setOpened,
    setTranscriptMemoryId: selection.setTranscriptMemoryId,
    setIsForgetDialogOpen: selection.setIsForgetDialogOpen,
    setError: selection.setError,
    setQuery: filters.setQuery,
    setSearch: filters.setSearch,
    setCategory: filters.setCategory,
    setFrom: filters.setFrom,
    setTo: filters.setTo,
    setPersonFilter: filters.setPersonFilter,
    setOperators: filters.setOperators,
  });
  const isTranscriptFocused =
    selection.transcriptMemoryId !== null &&
    selection.transcriptMemoryId !== "" &&
    (displayMode === "stack" || selection.opened?.id === selection.transcriptMemoryId);
  const browserHref = buildWorkspaceMemoryBrowserHref({
    view: input.view,
    search: filters.search,
    operators: filters.operators,
    category: filters.category,
    personFilter: filters.personFilter,
    from: filters.from,
    to: filters.to,
  });
  const backHref = readWorkspaceMemoryBackHref(searchParams.get("return"));
  const browserControls = useWorkspaceMemoryPageBrowserEffects({
    view: input.view,
    personId: input.personId,
    opener,
    selection,
    filters,
    memoryList,
    isMemoryNavigationEnabled,
  });

  return {
    token,
    workspaceId,
    key,
    status,
    client,
    billing,
    paymentStatus,
    isUpgradeRequired,
    isMemoryNavigationEnabled,
    router,
    memoryList,
    virtualList,
    cardBrowser,
    displayMode,
    setDisplayMode,
    handledMemoryLink,
    memoryLinkSearch,
    scrollToMemory,
    requestedMemoryId,
    forgetIds,
    setForgetIds,
    filters,
    selection,
    isTranscriptFocused,
    browserHref,
    backHref,
    ...browserControls,
  };
}

function useWorkspaceMemoryPageState({
  view = "all",
  personId,
}: {
  view?: "all" | "people";
  personId?: string;
}): WorkspaceMemoryPageState {
  const chrome = useWorkspaceMemoryPageChrome({ view, personId });
  const pageData = useWorkspaceMemoryPageData({
    client: chrome.client,
    token: chrome.token,
    workspaceId: chrome.workspaceId,
    key: chrome.key,
    status: chrome.status,
    view,
    personId,
    filters: chrome.filters,
    selection: chrome.selection,
    isMemoryNavigationEnabled: chrome.isMemoryNavigationEnabled,
    requestedMemoryId: chrome.requestedMemoryId,
    handledMemoryLink: chrome.handledMemoryLink,
    memoryLinkSearch: chrome.memoryLinkSearch,
    scrollToMemory: chrome.scrollToMemory,
    virtualList: chrome.virtualList,
    browserHref: chrome.browserHref,
    closeMemory: chrome.closeMemory,
    updateBrowserUrl: chrome.updateBrowserUrl,
    setForgetIds: chrome.setForgetIds,
    isTranscriptFocused: chrome.isTranscriptFocused,
  });

  return assembleWorkspaceMemoryPageState({
    view,
    personId,
    router: chrome.router,
    backHref: chrome.backHref,
    isUpgradeRequired: chrome.isUpgradeRequired,
    isMemoryNavigationEnabled: chrome.isMemoryNavigationEnabled,
    status: chrome.status,
    billing: chrome.billing,
    selection: chrome.selection,
    filters: chrome.filters,
    pageData,
    isTranscriptFocused: chrome.isTranscriptFocused,
    closeMemory: chrome.closeMemory,
    openMemory: chrome.openMemory,
    displayMode: chrome.displayMode,
    cardBrowser: chrome.cardBrowser,
    setDisplayMode: chrome.setDisplayMode,
    memoryList: chrome.memoryList,
    virtualList: chrome.virtualList,
    browserHref: chrome.browserHref,
    changeFilters: chrome.changeFilters,
    forgetIds: chrome.forgetIds,
    paymentStatus: chrome.paymentStatus,
    token: chrome.token,
    workspaceId: chrome.workspaceId,
    client: chrome.client,
  });
}

export function WorkspaceMemoryPage({ view = "all", personId }: { view?: "all" | "people"; personId?: string }) {
  return WorkspaceMemoryPageLayout(useWorkspaceMemoryPageState({ view, personId }));
}

function useMemoryUpgradePeoplePreviewInert(input: {
  view: "all" | "people" | "person";
  hasPreview: boolean;
  previewRef: RefObject<HTMLDivElement | null>;
  upgradeStage: RefObject<HTMLDivElement | null>;
}) {
  const { view, hasPreview, previewRef, upgradeStage } = input;
  useLayoutEffect(() => {
    const preview = previewRef.current;
    const list = preview?.querySelector<HTMLElement>("[data-memory-browser-list]");
    const stage = upgradeStage.current;
    const scrollport = preview?.closest<HTMLElement>(".relationship-memory-content");
    if (view !== "people") {
      return;
    }
    if (!list || !stage || !preview || !scrollport) {
      return;
    }

    const updateVisibility = () => {
      const bounds = preview.getBoundingClientRect();
      const scrollportBounds = scrollport.getBoundingClientRect();
      const scrim = getComputedStyle(scrollport, "::before");
      const scrimTop = parseFloat(scrim.top);
      const scrimHeight = parseFloat(scrim.height);
      const toolbarBottom =
        scrim.position === "fixed" && scrim.display !== "none"
          ? (Number.isFinite(scrimTop) ? scrimTop : 0) + (Number.isFinite(scrimHeight) ? scrimHeight : 0)
          : 0;
      const fadeHeightRaw = parseFloat(getComputedStyle(stage).getPropertyValue("--memory-upgrade-fade-height"));
      const fadeHeight = Number.isFinite(fadeHeightRaw) ? fadeHeightRaw : MEMORY_UPGRADE_FADE_HEIGHT_FALLBACK_PX;
      const top = Math.max(0, bounds.top, scrollportBounds.top + scrollport.clientTop, toolbarBottom);
      const bottom = Math.min(
        window.innerHeight,
        scrollportBounds.bottom,
        bounds.bottom,
        stage.getBoundingClientRect().top - fadeHeight,
      );
      [
        ...list.querySelectorAll<HTMLElement>(
          ".relationship-memory-group > .relationship-memory-group-heading, .relationship-people-list > li",
        ),
      ].forEach((item) => {
        const rect = item.getBoundingClientRect();
        const isExposed =
          rect.height > 0 &&
          rect.width > 0 &&
          rect.top >= top &&
          rect.bottom <= bottom &&
          rect.left >= bounds.left &&
          rect.right <= bounds.right &&
          !item.closest("[hidden]");
        if (!isExposed && item.contains(document.activeElement)) {
          stage.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
        }
        item.toggleAttribute("inert", !isExposed);
        if (isExposed) {
          item.removeAttribute("aria-hidden");
        } else {
          item.setAttribute("aria-hidden", "true");
        }
      });
    };
    updateVisibility();
    const resize = new ResizeObserver(updateVisibility);
    resize.observe(list);
    resize.observe(preview);
    resize.observe(stage);
    resize.observe(scrollport);
    const mutations = new MutationObserver(updateVisibility);
    mutations.observe(list, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["hidden"],
    });
    window.addEventListener("resize", updateVisibility);
    window.addEventListener("scroll", updateVisibility, true);

    return () => {
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", updateVisibility);
      window.removeEventListener("scroll", updateVisibility, true);
    };
  }, [view, hasPreview, previewRef, upgradeStage]);
}

type MemoryUpgradeGateProps = {
  personContent?: React.ReactNode;
  arrivals: ReturnType<typeof useMemoryArrivals>;
  displayMode: MemoryDisplayMode;
  browserRef?: React.RefObject<MemoryCardBrowserHandle | null>;
  onModeChange: (mode: MemoryDisplayMode) => void;
  paymentStatus?: "processing" | "failed";
  token: string;
  workspaceId: string;
  view: "all" | "people" | "person";
  memories: RelationshipMemory[];
  people: MemoryPerson[];
  returnTo: string;
};

function readMemoryUpgradePreviewContent(input: {
  view: MemoryUpgradeGateProps["view"];
  personContent?: React.ReactNode;
  people: MemoryPerson[];
  returnTo: string;
  previewMemories: RelationshipMemory[];
  virtualList: RefObject<MemoryVirtualListHandle | null>;
}) {
  if (input.view === "person") {
    return <div className="relationship-person-upgrade-content">{input.personContent}</div>;
  }
  if (input.view === "people") {
    return <MemoryPeopleList people={input.people} returnTo={input.returnTo} isUpgradePreview />;
  }

  return <MemoryVirtualList ref={input.virtualList} memories={input.previewMemories} preview />;
}

function MemoryUpgradeGate(props: MemoryUpgradeGateProps) {
  const {
    paymentStatus,
    token,
    workspaceId,
    view,
    memories,
    people,
    returnTo,
    displayMode,
    browserRef,
    onModeChange,
    arrivals,
    personContent,
  } = props;
  const virtualList = useRef<MemoryVirtualListHandle | null>(null);
  const upgradeStage = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const hasPreview = view === "person" || (view === "people" ? people.length !== 0 : memories.length !== 0);
  useMemoryUpgradePeoplePreviewInert({ view, hasPreview, previewRef, upgradeStage });
  const previewMemories = useMemo(() => memories.slice(0, MEMORY_UPGRADE_PREVIEW_COUNT), [memories]);
  const listPreview = hasPreview && (
    <div
      ref={previewRef}
      className={`relationship-memory-upgrade-preview${view === "people" ? " is-interactive-people" : ""}`}
      aria-hidden={view === "people" ? undefined : true}
      inert={view !== "people"}
    >
      {readMemoryUpgradePreviewContent({
        view,
        personContent,
        people,
        returnTo,
        previewMemories,
        virtualList,
      })}
    </div>
  );

  return (
    <div
      className={`relationship-memory-upgrade${view !== "all" ? " is-people-gate" : ""}${hasPreview ? " has-preview" : ""}${browserRef && view === "all" && displayMode === "stack" ? " is-card-preview" : ""}`}
    >
      {hasPreview && view === "all" && browserRef ? (
        <MemoryCardBrowser
          ref={browserRef}
          listRef={virtualList}
          {...arrivals}
          memories={previewMemories}
          upgradePreview
          mode={displayMode}
          onModeChange={onModeChange}
          disabled={false}
          hasMore={false}
          loadingMore={false}
          loadMore={() => {}}
          renderCard={({ memory }) => (
            <article className="relationship-memory-detail" aria-hidden="true" inert>
              <header>
                <h2>{memory.title}</h2>
              </header>
              <p className="relationship-detail-description">{memory.description}</p>
              <div className="relationship-detail-footer">
                <button className="relationship-evidence-toggle" disabled>
                  View transcript <MemoryIcon name="external" />
                </button>
                <button className="relationship-forget-button" disabled>
                  Forget
                </button>
              </div>
            </article>
          )}
        >
          {listPreview}
        </MemoryCardBrowser>
      ) : (
        listPreview
      )}
      <div ref={upgradeStage} className="relationship-memory-upgrade-stage">
        <MeetingProUpgradeCard
          token={token}
          workspaceId={workspaceId}
          paymentStatus={paymentStatus}
          logoPlaybackKey={`memory:${workspaceId}`}
        />
      </div>
    </div>
  );
}
// Long contact histories render only the month groups near the scrollport;
// the rest keep their exact height, so scrolling and the scrollbar are unchanged.
const PEOPLE_WINDOW_MIN_ROWS = 60;
const PEOPLE_WINDOW_OVERSCAN = "1200px 0px";
const PEOPLE_ROW_HEIGHT = 44;
const peopleMonthFormatter: { current: Intl.DateTimeFormat | null } = { current: null };
function groupPeopleByMonth(people: MemoryPerson[]) {
  const formatter = (peopleMonthFormatter.current ??= new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }));

  return [
    ...people.reduce((groups, person) => {
      const label = formatter.format(new Date(person.lastContact));
      const group = groups.get(label);

      return new Map(groups).set(label, group === undefined ? [person] : [...group, person]);
    }, new Map<string, MemoryPerson[]>()),
  ];
}
function useMemoryPeopleNearGroupObserver(input: {
  listRef: RefObject<HTMLDivElement | null>;
  isWindowed: boolean;
  groupSignature: string;
}) {
  const { listRef, isWindowed, groupSignature } = input;
  const [nearGroups, setNearGroups] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!isWindowed || !list) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) =>
        setNearGroups((current) => {
          const next = new Set(current ?? []);
          entries.forEach((entry) => {
            if (!(entry.target instanceof HTMLElement)) {
              return;
            }
            const label = entry.target.dataset.peopleGroup ?? "";
            if (entry.isIntersecting) {
              next.add(label);
            } else {
              next.delete(label);
            }
          });

          return current && next.size === current.size && [...next].every((label) => current.has(label))
            ? current
            : next;
        }),
      { root: list.closest(".relationship-memory-content"), rootMargin: PEOPLE_WINDOW_OVERSCAN },
    );
    list.querySelectorAll("[data-people-group]").forEach((element) => {
      observer.observe(element);
    });

    return () => observer.disconnect();
  }, [isWindowed, groupSignature, listRef]);

  return nearGroups;
}

function navigateMemoryPeopleRowFocus(input: {
  event: KeyboardEvent<HTMLAnchorElement>;
  personId: string;
  isWindowed: boolean;
  isUpgradePreview: boolean;
  listRef: RefObject<HTMLDivElement | null>;
  groups: ReturnType<typeof groupPeopleByMonth>;
  pendingFocus: RefObject<string | null>;
  setFocusedPersonId: (personId: string) => void;
}) {
  const { event, personId, isWindowed, isUpgradePreview, listRef, groups, pendingFocus, setFocusedPersonId } = input;
  if (!isWindowed || isUpgradePreview) {
    moveRowFocus(event);

    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    return;
  }
  const availableGroups = new Set(
    [...(listRef.current?.querySelectorAll<HTMLElement>("[data-people-group]") ?? [])]
      .filter((group) => !group.closest('[hidden], [inert], [aria-hidden="true"]'))
      .map((group) => group.dataset.peopleGroup?.split("\0")[0]),
  );
  const rows = groups.filter(([label]) => availableGroups.has(label)).flatMap(([, group]) => group);
  const index = rows.findIndex((person) => person.id === personId);
  if (index < 0) {
    return;
  }
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
  event.preventDefault();
  const target = rows[next];
  if (target === undefined) {
    return;
  }
  const targetId = target.id;
  if (targetId === personId) {
    return;
  }
  pendingFocus.current = targetId;
  setFocusedPersonId(targetId);
}

function initialPeopleGroups(groups: ReturnType<typeof groupPeopleByMonth>) {
  const selected = groups.reduce<{ labels: string[]; rows: number }>(
    (state, [label, group]) => {
      if (state.rows >= PEOPLE_WINDOW_MIN_ROWS) {
        return state;
      }

      return { labels: [...state.labels, label], rows: state.rows + Math.min(group.length, PEOPLE_CHUNK_SIZE) };
    },
    { labels: [], rows: 0 },
  );

  return new Set(selected.labels);
}
type MemoryPeopleListProps = {
  people: MemoryPerson[];
  returnTo: string;
  isUpgradePreview?: boolean;
};

function MemoryPeopleGroupsRender({
  groups,
  isWindowed,
  renderedGroups,
  isUpgradePreview,
  rowHeight,
  returnTo,
  focusedPersonId,
  setFocusedPersonId,
  listRef,
  pendingFocus,
}: {
  groups: ReturnType<typeof groupPeopleByMonth>;
  isWindowed: boolean;
  renderedGroups: ReadonlySet<string>;
  isUpgradePreview: boolean;
  rowHeight: number;
  returnTo: string;
  focusedPersonId: string | null;
  setFocusedPersonId: (personId: string) => void;
  listRef: RefObject<HTMLDivElement | null>;
  pendingFocus: RefObject<string | null>;
}) {
  return groups.map(([label, group], groupIndex) => (
    <MemoryGroup key={label} label={label} count={group.length} headingInert={isUpgradePreview}>
      {Array.from({ length: Math.ceil(group.length / PEOPLE_CHUNK_SIZE) }, (_, chunkIndex) => {
        const chunk = group.slice(chunkIndex * PEOPLE_CHUNK_SIZE, (chunkIndex + 1) * PEOPLE_CHUNK_SIZE);
        const chunkKey = chunkIndex !== 0 ? `${label}\0${chunkIndex}` : label;

        return isWindowed && !renderedGroups.has(chunkKey) && !chunk.some((person) => person.id === focusedPersonId) ? (
          <ol
            className="relationship-people-list"
            key={chunkKey}
            data-people-group={chunkKey}
            data-people-group-index={groupIndex}
            style={{ height: chunk.length * rowHeight }}
          />
        ) : (
          <ol
            className="relationship-people-list"
            key={chunkKey}
            data-people-group={chunkKey}
            data-people-group-index={groupIndex}
          >
            {chunk.map((p) => (
              <li key={p.id} inert={isUpgradePreview} aria-hidden={isUpgradePreview || undefined}>
                <Link
                  data-browser-row
                  data-person-id={p.id}
                  onFocus={() => {
                    if (isWindowed && !isUpgradePreview) {
                      setFocusedPersonId(p.id);
                    }
                  }}
                  onKeyDown={(event) =>
                    navigateMemoryPeopleRowFocus({
                      event,
                      personId: p.id,
                      isWindowed,
                      isUpgradePreview,
                      listRef,
                      groups,
                      pendingFocus,
                      setFocusedPersonId,
                    })
                  }
                  aria-label={`${MESSAGE_MEMORY_OPEN_PERSON_PREFIX}${p.name}`}
                  href={`/workspace/memory/people/${p.id}?return=${encodeURIComponent(returnTo)}`}
                >
                  <span className="relationship-person-row-photo">
                    <PersonInitials name={p.name} imageUrl={p.imageUrl} />
                  </span>
                  <strong>{p.name}</strong>
                  {p.companyName !== undefined && p.companyName !== "" ? (
                    <span className="relationship-person-company" title={p.companyDomain ?? undefined}>
                      {p.companyName}
                    </span>
                  ) : null}
                  <time dateTime={p.lastContact} title={dateLabel(p.lastContact)}>
                    {contactAgeInDays(p.lastContact)}
                  </time>
                </Link>
              </li>
            ))}
          </ol>
        );
      })}
    </MemoryGroup>
  ));
}

function MemoryPeopleList({ people, returnTo, isUpgradePreview = false }: MemoryPeopleListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupPeopleByMonth(people), [people]);
  const groupSignature = groups.map(([label, group]) => `${label}:${group.length}`).join("|");
  const isWindowed = people.length > PEOPLE_WINDOW_MIN_ROWS && typeof IntersectionObserver !== "undefined";
  const [focusedPersonId, setFocusedPersonId] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const [rowHeight, setRowHeight] = useState(PEOPLE_ROW_HEIGHT);
  useMemoryPeopleScrollAnchor({ listRef, groups, rowHeight });
  const nearGroups = useMemoryPeopleNearGroupObserver({ listRef, isWindowed, groupSignature });
  const renderedGroups = nearGroups ?? initialPeopleGroups(groups);
  useLayoutEffect(() => {
    const height = listRef.current?.querySelector<HTMLElement>(".relationship-people-list > li")?.offsetHeight;
    if (height !== undefined && height !== 0 && Math.abs(height - rowHeight) > PEOPLE_ROW_HEIGHT_TOLERANCE_PX) {
      setRowHeight(height);
    }
  });
  useLayoutEffect(() => {
    if (pendingFocus.current === null || pendingFocus.current === "") {
      return;
    }
    const target = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-person-id]") ?? [])].find(
      (row) => row.dataset.personId === pendingFocus.current,
    );
    pendingFocus.current = null;
    // Native focus scrolls the newly rendered row into view. Keep its group
    // mounted while focused, including before the observer catches up.
    target?.focus();
  });
  if (people.length === 0) {
    return (
      <div className="workspace-task-empty-visual" role="status" aria-label={MESSAGE_MEMORY_NO_PEOPLE}>
        <PeopleNavIcon />
      </div>
    );
  }

  return (
    <div
      data-memory-browser-list
      style={{ overflowAnchor: "none" }}
      ref={listRef}
      onBlurCapture={(event) => {
        if (focusedPersonId !== null && !event.currentTarget.contains(event.relatedTarget)) {
          setFocusedPersonId(null);
        }
      }}
    >
      <MemoryPeopleGroupsRender
        groups={groups}
        isWindowed={isWindowed}
        renderedGroups={renderedGroups}
        isUpgradePreview={isUpgradePreview}
        rowHeight={rowHeight}
        returnTo={returnTo}
        focusedPersonId={focusedPersonId}
        setFocusedPersonId={setFocusedPersonId}
        listRef={listRef}
        pendingFocus={pendingFocus}
      />
    </div>
  );
}
