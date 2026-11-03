"use client";

import { canRetryAmbientContextResearch } from "@readymeet/shared";
import {
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ThinkingOrb } from "thinking-orbs";

import {
  ambientContextItemHasReadableResult,
  ambientContextItemIsResearching,
  ambientContextMonogram,
  ambientContextPrivateDetails,
  ambientContextSecondaryLine,
  type AmbientContextViewItem,
} from "../../domain/ambient-context-view";
import {
  capitalizeLeadingLetter,
  relevantDetailsHistoryItems,
  type WebSearchPanelState,
} from "../../domain/relevant-details";
import {
  isVoiceWebSearchLookingForAnswer,
  type VoiceWebSearchEntityResult,
  type VoiceWebSearchResult,
  type VoiceWebSearchSourceResult,
  WEB_SEARCH_LOADER_FADE_MS,
  WEB_SEARCH_LOADER_MIN_VISIBLE_MS,
} from "../../domain/voice-web-search";

import { MemoryIcon } from "./memory-icons";
import { AnimatedWorkspaceText, getWorkspaceTextRevealDuration } from "./workspace-generated-notes";

const AMBIENT_CONTEXT_ARTICLE_PREVIEW_COUNT = 3;
const AMBIENT_CONTEXT_CITATION_PREVIEW_COUNT = 5;
const AMBIENT_CONTEXT_SOURCES_PREVIEW_COUNT = 8;
const AMBIENT_CONTEXT_REVEAL_CHAR_DELAY_MS = 3.5;
const AMBIENT_CONTEXT_UPDATED_AT_FORMAT_OPTIONS = {
  dateStyle: "medium",
  timeStyle: "short",
} satisfies Intl.DateTimeFormatOptions;
const ambientContextUpdatedAtFormatter = new Intl.DateTimeFormat(undefined, AMBIENT_CONTEXT_UPDATED_AT_FORMAT_OPTIONS);

const AMBIENT_CONTEXT_PANEL_COPY = {
  closePanelAriaLabel: "Close relevant details panel",
  panelAriaLabel: "Relevant meeting details",
  historyRecent: "Recent",
  historyMenuAriaLabel: "Relevant details history",
  loaderReviewingMeeting: "Reviewing the meeting",
  loaderSearching: "Searching",
  privateContextAriaLabel: "Private context",
  fromYourMemory: "From your memory",
  whereThingsStand: "Where things stand",
  ashbyLinkLabel: "Ashby",
  fromTheWeb: "From the web",
  searchingTheWeb: "Searching the web…",
  researchTakingLonger: "Research is taking longer than expected.",
  retryChecking: "Checking…",
  retryTryAgain: "Try again",
  researchVerifiedFailed: "New details couldn’t be verified. Your previous research is still available.",
  researchReadyFailed: "Ready couldn’t finish this research.",
  updatedPrefix: "Updated ",
  researchSourcesAriaLabel: "Research sources",
  allSources: "All sources",
  citationSourceFallback: "source",
  meetingReviewFailed: "I couldn't finish reviewing the meeting.",
  meetingReviewBasedOnTranscript: "Based on the saved transcript when you asked.",
  meetingReviewInProgress: "Reviewing the meeting",
  webSearchUnavailable: "Web search is unavailable.",
  stillCheckingSources: "Still checking sources...",
  stillFindingMatches: "Still finding matches...",
  noReliableAnswer: "I couldn't find a reliable answer.",
  searchCompleted: "Search completed.",
  answerPreviewLabel: "Answer preview",
  previewSourcesAriaLabel: "Preview sources",
  answerConfidencePrefix: "Answer ·",
  answerConfidenceSuffix: "confidence",
  answerSourcesAriaLabel: "Answer sources",
  entityPerson: "Person",
  entityCompany: "Company",
  entityProduct: "Product",
  entityDefault: "Entity",
  sourceFallback: "Source",
  sourcesDetailsLabel: "Sources",
  webSearchSanitizedSourceLabel: "current sources",
  metaSeparator: " · ",
  answerSectionKeyFallback: "section",
};

function ambientItemHasWebResult(item: AmbientContextViewItem): boolean {
  const summaryText = item.summary?.trim() ?? "";

  return summaryText.length > 0 || item.facts.length !== 0 || item.citations.length !== 0;
}

function resolveSelectedHistoryItem({
  historyItems,
  selectedItemKey,
}: {
  historyItems: ReturnType<typeof relevantDetailsHistoryItems>;
  selectedItemKey: string | null;
}) {
  return (
    historyItems.find(
      (item) =>
        (item.key === selectedItemKey ||
          (item.kind === "ambient" &&
            item.item.selectionAliases?.some((id) => `ambient:${id}` === selectedItemKey))) === true,
    ) ??
    historyItems[0] ??
    null
  );
}

function computeShouldRenderAmbientLoader({
  isOpen,
  selectedHistoryItem,
  isLoading,
  loaderPhase,
  hasPrivate,
}: {
  isOpen: boolean;
  selectedHistoryItem: ReturnType<typeof resolveSelectedHistoryItem>;
  isLoading: boolean;
  loaderPhase: "hidden" | "visible" | "exiting";
  hasPrivate: boolean;
}): boolean {
  const hasActiveLoader = isLoading || loaderPhase !== "hidden";

  return (
    isOpen && selectedHistoryItem !== null && hasActiveLoader && !(selectedHistoryItem.kind === "ambient" && hasPrivate)
  );
}

function computeSelectedHistoryItemLoading({
  selectedHistoryItem,
  expiredItemIds,
}: {
  selectedHistoryItem: ReturnType<typeof resolveSelectedHistoryItem>;
  expiredItemIds: ReadonlySet<string>;
}): boolean {
  if (selectedHistoryItem?.kind === "ambient") {
    return (
      !expiredItemIds.has(selectedHistoryItem.item.id) &&
      !ambientContextItemHasReadableResult(selectedHistoryItem.item) &&
      ambientContextItemIsResearching(selectedHistoryItem.item)
    );
  }
  if (selectedHistoryItem?.kind === "web-search") {
    return isVoiceWebSearchLookingForAnswer(selectedHistoryItem.state);
  }

  return false;
}

function uniqueAmbientArticleCitations(item: AmbientContextViewItem) {
  return item.citations
    .filter((citation) => citation.isArticle === true)
    .filter((citation, index, all) => all.findIndex((other) => other.url === citation.url) === index)
    .slice(0, AMBIENT_CONTEXT_ARTICLE_PREVIEW_COUNT);
}

type AmbientContextPanelProps = {
  ambientItems: AmbientContextViewItem[];
  expiredItemIds: ReadonlySet<string>;
  webSearchItems: WebSearchPanelState[];
  imageUrls: Record<string, string>;
  isOpen: boolean;
  selectedItemKey: string | null;
  onSelect: (itemKey: string) => void;
  onRetry: (itemId: string) => Promise<void>;
  onClose: () => void;
  /** @external ambient panel reveal wire */
  revealContent?: boolean;
  factsLayout?: "bullets" | "standing";
  loaderMinVisibleMs?: number;
};

function useAmbientPanelLoaderPhase({
  isOpen,
  isLoading,
  loadingKey,
  loaderMinVisibleMs,
}: {
  isOpen: boolean;
  isLoading: boolean;
  loadingKey: string | null;
  loaderMinVisibleMs: number;
}) {
  const [loaderPhase, setLoaderPhase] = useState<"hidden" | "visible" | "exiting">("hidden");
  const loaderStartedAtRef = useRef<number | null>(null);
  const loaderKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      loaderStartedAtRef.current = null;
      loaderKeyRef.current = null;
      setLoaderPhase("hidden");

      return;
    }
    if (!isLoading) {
      if (Boolean(loaderKeyRef.current) && loaderKeyRef.current !== loadingKey) {
        loaderStartedAtRef.current = null;
        loaderKeyRef.current = null;
        setLoaderPhase("hidden");
      }

      return;
    }
    if (loaderKeyRef.current !== loadingKey || loaderStartedAtRef.current === null) {
      loaderStartedAtRef.current = Date.now();
      loaderKeyRef.current = loadingKey;
    }
    setLoaderPhase("visible");
  }, [isLoading, isOpen, loadingKey]);

  useEffect(() => {
    if (!isOpen || isLoading || loaderPhase !== "visible") {
      return;
    }
    const startedAt = loaderStartedAtRef.current ?? Date.now();
    const remainingMs = Math.max(0, loaderMinVisibleMs - (Date.now() - startedAt));
    const timeoutId = window.setTimeout(() => setLoaderPhase("exiting"), remainingMs);

    return () => window.clearTimeout(timeoutId);
  }, [isLoading, isOpen, loaderPhase, loaderMinVisibleMs]);

  useEffect(() => {
    if (loaderPhase !== "exiting") {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      loaderStartedAtRef.current = null;
      loaderKeyRef.current = null;
      setLoaderPhase("hidden");
    }, WEB_SEARCH_LOADER_FADE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [loaderPhase]);

  return loaderPhase;
}

function useAmbientPanelHistoryMenuDismiss({
  isHistoryOpen,
  setIsHistoryOpen,
  historyRef,
}: {
  isHistoryOpen: boolean;
  setIsHistoryOpen: Dispatch<SetStateAction<boolean>>;
  historyRef: RefObject<HTMLDivElement | null>;
}) {
  useEffect(() => {
    if (!isHistoryOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !(historyRef.current?.contains(event.target) ?? false)) {
        setIsHistoryOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsHistoryOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [historyRef, isHistoryOpen, setIsHistoryOpen]);
}

function useAmbientContextPanel({
  ambientItems,
  expiredItemIds,
  webSearchItems,
  selectedItemKey,
  onSelect,
  onClose,
  isOpen,
  loaderMinVisibleMs,
}: Omit<AmbientContextPanelProps, "imageUrls" | "onRetry" | "loaderMinVisibleMs"> & { loaderMinVisibleMs: number }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const [failedImageIds, setFailedImageIds] = useState<Set<string>>(() => new Set());
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [retryingItemId, setRetryingItemId] = useState<string | null>(null);
  const historyItems = useMemo(
    () => relevantDetailsHistoryItems({ ambientItems, webSearchItems }),
    [ambientItems, webSearchItems],
  );
  const selectedHistoryItem = resolveSelectedHistoryItem({ historyItems, selectedItemKey });
  useEffect(() => {
    if (
      Boolean(selectedItemKey) &&
      selectedHistoryItem?.key !== selectedItemKey &&
      selectedHistoryItem?.kind === "ambient" &&
      selectedHistoryItem.item.selectionAliases?.some((id) => `ambient:${id}` === selectedItemKey) === true
    ) {
      onSelect(selectedHistoryItem.key);
    }
  }, [selectedItemKey, selectedHistoryItem, onSelect]);
  const selectedAmbientItem = selectedHistoryItem?.kind === "ambient" ? selectedHistoryItem.item : null;
  const isLoading = computeSelectedHistoryItemLoading({ selectedHistoryItem, expiredItemIds });
  const loadingKey = selectedHistoryItem?.key ?? null;
  const selectedPrivate = selectedAmbientItem ? ambientContextPrivateDetails(selectedAmbientItem) : null;
  const hasPrivate =
    (selectedPrivate?.memory !== undefined && selectedPrivate.memory !== null) ||
    (selectedPrivate?.ashby !== undefined && selectedPrivate.ashby !== null);
  const isWebLoading = selectedAmbientItem?.status === "researching" && !expiredItemIds.has(selectedAmbientItem.id);

  const loaderPhase = useAmbientPanelLoaderPhase({ isOpen, isLoading, loadingKey, loaderMinVisibleMs });
  useAmbientPanelHistoryMenuDismiss({ isHistoryOpen, setIsHistoryOpen, historyRef });
  const shouldRenderLoader = computeShouldRenderAmbientLoader({
    isOpen,
    selectedHistoryItem,
    isLoading,
    loaderPhase,
    hasPrivate,
  });

  useEffect(() => {
    // Pending research is represented by a history item. Without any items,
    // there is no work for this panel to wait on.
    if (isOpen && historyItems.length === 0) {
      onClose();
    }
  }, [isOpen, historyItems.length, onClose]);

  useEffect(() => {
    if (!isOpen) {
      setIsHistoryOpen(false);

      return;
    }
    bodyRef.current?.scrollTo({ top: 0 });
  }, [isOpen, selectedHistoryItem?.key]);

  return {
    bodyRef,
    historyRef,
    failedImageIds,
    setFailedImageIds,
    isHistoryOpen,
    setIsHistoryOpen,
    retryingItemId,
    setRetryingItemId,
    historyItems,
    selectedHistoryItem,
    selectedAmbientItem,
    hasPrivate,
    selectedPrivate,
    isWebLoading,
    shouldRenderLoader,
    loaderPhase,
  };
}

export function AmbientContextPanel(props: AmbientContextPanelProps) {
  const {
    ambientItems,
    expiredItemIds,
    webSearchItems,
    imageUrls,
    isOpen,
    selectedItemKey,
    onSelect,
    onRetry,
    onClose,
    factsLayout = "bullets",
    loaderMinVisibleMs = WEB_SEARCH_LOADER_MIN_VISIBLE_MS,
  } = props;
  const {
    bodyRef,
    historyRef,
    failedImageIds,
    setFailedImageIds,
    isHistoryOpen,
    setIsHistoryOpen,
    retryingItemId,
    setRetryingItemId,
    historyItems,
    selectedHistoryItem,
    selectedAmbientItem,
    hasPrivate,
    selectedPrivate,
    isWebLoading,
    shouldRenderLoader,
    loaderPhase,
  } = useAmbientContextPanel({
    ambientItems,
    expiredItemIds,
    webSearchItems,
    selectedItemKey,
    onSelect,
    onClose,
    isOpen,
    loaderMinVisibleMs,
  });

  return (
    <AmbientContextPanelView
      isOpen={isOpen}
      onClose={onClose}
      factsLayout={factsLayout}
      historyRef={historyRef}
      bodyRef={bodyRef}
      historyItems={historyItems}
      isHistoryOpen={isHistoryOpen}
      setIsHistoryOpen={setIsHistoryOpen}
      selectedHistoryItem={selectedHistoryItem}
      onSelect={onSelect}
      shouldRenderLoader={shouldRenderLoader}
      loaderPhase={loaderPhase}
      selectedAmbientItem={selectedAmbientItem}
      selectedPrivate={selectedPrivate}
      hasPrivate={hasPrivate}
      imageUrls={imageUrls}
      failedImageIds={failedImageIds}
      setFailedImageIds={setFailedImageIds}
      revealContent={props.revealContent ?? false}
      expiredItemIds={expiredItemIds}
      isWebLoading={isWebLoading}
      retryingItemId={retryingItemId}
      setRetryingItemId={setRetryingItemId}
      onRetry={onRetry}
    />
  );
}

function AmbientContextPanelHistoryHeader({
  historyItems,
  historyRef,
  isHistoryOpen,
  setIsHistoryOpen,
  selectedHistoryItem,
  onSelect,
  onClose,
  bodyRef,
}: {
  historyItems: ReturnType<typeof relevantDetailsHistoryItems>;
  historyRef: RefObject<HTMLDivElement | null>;
  isHistoryOpen: boolean;
  setIsHistoryOpen: Dispatch<SetStateAction<boolean>>;
  selectedHistoryItem: ReturnType<typeof resolveSelectedHistoryItem>;
  onSelect: (itemKey: string) => void;
  onClose: () => void;
  bodyRef: RefObject<HTMLDivElement | null>;
}) {
  if (historyItems.length === 0) {
    return (
      <button
        type="button"
        className="live-presence-sheet-close"
        onClick={onClose}
        aria-label={AMBIENT_CONTEXT_PANEL_COPY.closePanelAriaLabel}
        title={AMBIENT_CONTEXT_PANEL_COPY.closePanelAriaLabel}
      >
        ×
      </button>
    );
  }

  return (
    <div className="live-presence-sheet-header live-ambient-context-header">
      <div className="live-ambient-context-history" ref={historyRef}>
        <button
          type="button"
          className="live-ambient-context-history-trigger"
          aria-haspopup="listbox"
          /** @external aria-expanded wire */
          aria-expanded={isHistoryOpen}
          onClick={() => setIsHistoryOpen((isHistoryOpenNow) => !isHistoryOpenNow)}
        >
          <span>{AMBIENT_CONTEXT_PANEL_COPY.historyRecent}</span>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="m2.25 4.25 3.75 3.5 3.75-3.5" />
          </svg>
        </button>
        {isHistoryOpen ? (
          <div
            className="live-ambient-context-history-menu"
            role="listbox"
            aria-label={AMBIENT_CONTEXT_PANEL_COPY.historyMenuAriaLabel}
          >
            {historyItems.map((item) => (
              <button
                key={item.key}
                type="button"
                className="live-ambient-context-history-option"
                role="option"
                aria-selected={selectedHistoryItem?.key === item.key}
                onClick={() => {
                  onSelect(item.key);
                  setIsHistoryOpen(false);
                  bodyRef.current?.scrollTo({ top: 0 });
                }}
              >
                <span>{item.title}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="live-presence-sheet-close"
        onClick={onClose}
        aria-label={AMBIENT_CONTEXT_PANEL_COPY.closePanelAriaLabel}
        title={AMBIENT_CONTEXT_PANEL_COPY.closePanelAriaLabel}
      >
        ×
      </button>
    </div>
  );
}

type AmbientContextPanelViewProps = {
  isOpen: boolean;
  onClose: () => void;
  factsLayout: "bullets" | "standing";
  historyRef: RefObject<HTMLDivElement | null>;
  bodyRef: RefObject<HTMLDivElement | null>;
  historyItems: ReturnType<typeof relevantDetailsHistoryItems>;
  isHistoryOpen: boolean;
  setIsHistoryOpen: Dispatch<SetStateAction<boolean>>;
  selectedHistoryItem: ReturnType<typeof resolveSelectedHistoryItem>;
  onSelect: (itemKey: string) => void;
  shouldRenderLoader: boolean;
  loaderPhase: "hidden" | "visible" | "exiting";
  selectedAmbientItem: AmbientContextViewItem | null;
  selectedPrivate: ReturnType<typeof ambientContextPrivateDetails>;
  hasPrivate: boolean;
  imageUrls: Record<string, string>;
  failedImageIds: Set<string>;
  setFailedImageIds: Dispatch<SetStateAction<Set<string>>>;
  /** @external ambient panel reveal wire */
  revealContent: boolean;
  expiredItemIds: ReadonlySet<string>;
  isWebLoading: boolean;
  retryingItemId: string | null;
  setRetryingItemId: Dispatch<SetStateAction<string | null>>;
  onRetry: (itemId: string) => Promise<void>;
};

function AmbientContextPanelView(viewProps: AmbientContextPanelViewProps) {
  const {
    isOpen,
    onClose,
    factsLayout,
    historyRef,
    bodyRef,
    historyItems,
    isHistoryOpen,
    setIsHistoryOpen,
    selectedHistoryItem,
    onSelect,
    shouldRenderLoader,
    loaderPhase,
    selectedAmbientItem,
    selectedPrivate,
    hasPrivate,
    imageUrls,
    failedImageIds,
    setFailedImageIds,
    expiredItemIds,
    isWebLoading,
    retryingItemId,
    setRetryingItemId,
    onRetry,
  } = viewProps;

  return (
    <>
      <button
        type="button"
        className={`live-presence-backdrop${isOpen ? " is-open" : ""}`}
        aria-label={AMBIENT_CONTEXT_PANEL_COPY.closePanelAriaLabel}
        aria-hidden={!isOpen}
        tabIndex={isOpen ? 0 : -1}
        onClick={onClose}
      />
      <aside
        className={`live-presence-panel live-web-search-sheet live-ambient-context-sheet${factsLayout === "standing" ? " has-standing-layout" : ""}${historyItems.length === 0 ? " is-empty" : ""}${isOpen ? " is-open" : ""}`}
        aria-hidden={!isOpen}
        aria-label={AMBIENT_CONTEXT_PANEL_COPY.panelAriaLabel}
      >
        <AmbientContextPanelHistoryHeader
          historyItems={historyItems}
          historyRef={historyRef}
          isHistoryOpen={isHistoryOpen}
          setIsHistoryOpen={setIsHistoryOpen}
          selectedHistoryItem={selectedHistoryItem}
          onSelect={onSelect}
          onClose={onClose}
          bodyRef={bodyRef}
        />
        <div
          className={`live-web-search-body live-ambient-context-body${historyItems.length === 0 ? " is-empty" : ""}${shouldRenderLoader ? " is-loading" : ""}`}
          ref={bodyRef}
        >
          {shouldRenderLoader ? (
            <WebSearchLoadingCard
              phase={loaderPhase}
              label={
                selectedHistoryItem?.kind === "web-search" && selectedHistoryItem.state.contentKind === "meeting-answer"
                  ? AMBIENT_CONTEXT_PANEL_COPY.loaderReviewingMeeting
                  : AMBIENT_CONTEXT_PANEL_COPY.loaderSearching
              }
            />
          ) : selectedHistoryItem?.kind === "web-search" ? (
            <WebSearchResultContent state={selectedHistoryItem.state} />
          ) : selectedAmbientItem ? (
            <SelectedAmbientContextCard
              item={selectedAmbientItem}
              selectedPrivate={selectedPrivate}
              hasPrivate={hasPrivate}
              imageUrls={imageUrls}
              failedImageIds={failedImageIds}
              setFailedImageIds={setFailedImageIds}
              factsLayout={factsLayout}
              revealContent={viewProps.revealContent}
              isOpen={isOpen}
              expiredItemIds={expiredItemIds}
              isWebLoading={isWebLoading}
              retryingItemId={retryingItemId}
              setRetryingItemId={setRetryingItemId}
              onRetry={onRetry}
            />
          ) : null}
        </div>
      </aside>
    </>
  );
}

type SelectedAmbientContextCardProps = {
  item: AmbientContextViewItem;
  selectedPrivate: ReturnType<typeof ambientContextPrivateDetails>;
  hasPrivate: boolean;
  imageUrls: Record<string, string>;
  failedImageIds: Set<string>;
  setFailedImageIds: Dispatch<SetStateAction<Set<string>>>;
  factsLayout: "bullets" | "standing";
  /** @external ambient panel reveal wire */
  revealContent: boolean;
  isOpen: boolean;
  expiredItemIds: ReadonlySet<string>;
  isWebLoading: boolean;
  retryingItemId: string | null;
  setRetryingItemId: Dispatch<SetStateAction<string | null>>;
  onRetry: (itemId: string) => Promise<void>;
};

function SelectedAmbientContextCard(cardProps: SelectedAmbientContextCardProps) {
  const {
    item,
    selectedPrivate,
    hasPrivate,
    imageUrls,
    failedImageIds,
    setFailedImageIds,
    factsLayout,
    isOpen,
    expiredItemIds,
    isWebLoading,
    retryingItemId,
    setRetryingItemId,
    onRetry,
  } = cardProps;
  const hasWebResult = ambientItemHasWebResult(item);
  const isArticlesOnly = item.entityKind === "person" && hasPrivate;
  const articles = uniqueAmbientArticleCitations(item);
  const shouldShowWebSection = isArticlesOnly ? articles.length !== 0 : !hasPrivate || hasWebResult || isWebLoading;
  const shouldReveal =
    (cardProps.revealContent || (item.memoryArrivalVersion !== undefined && item.memoryArrivalVersion.length > 0)) &&
    isOpen;
  const revealDelay = { next: 0 };
  const revealText = (text: string) => {
    if (!shouldReveal) {
      return text;
    }
    const delayMs = revealDelay.next;
    revealDelay.next += getWorkspaceTextRevealDuration({
      text,
      charDelayMs: AMBIENT_CONTEXT_REVEAL_CHAR_DELAY_MS,
    });

    return (
      <AnimatedWorkspaceText
        key={text}
        text={text}
        delayMs={delayMs}
        charDelayMs={AMBIENT_CONTEXT_REVEAL_CHAR_DELAY_MS}
      />
    );
  };

  return (
    <article key={item.id} className="live-web-search-result live-ambient-context-card is-expanded">
      <div className="live-ambient-context-card-trigger">
        <span className={`live-ambient-context-identity-image is-${item.entityKind}`}>
          {(imageUrls[item.id]?.length ?? 0) > 0 && !failedImageIds.has(item.id) ? (
            <img
              src={imageUrls[item.id]}
              alt=""
              onError={() =>
                setFailedImageIds((current) => {
                  const next = new Set(current);
                  next.add(item.id);

                  return next;
                })
              }
            />
          ) : (
            <span>{ambientContextMonogram(item)}</span>
          )}
        </span>
        <span className="live-web-search-result-title">{item.displayName}</span>
        {ambientContextSecondaryLine(item).length > 0 ? (
          <span className="live-ambient-context-secondary">{ambientContextSecondaryLine(item)}</span>
        ) : null}
      </div>

      <AmbientSelectedCardSections
        item={item}
        selectedPrivate={selectedPrivate}
        hasPrivate={hasPrivate}
        factsLayout={factsLayout}
        shouldReveal={shouldReveal}
        revealDelay={revealDelay}
        revealText={revealText}
        isArticlesOnly={isArticlesOnly}
        articles={articles}
        shouldShowWebSection={shouldShowWebSection}
        expiredItemIds={expiredItemIds}
        isWebLoading={isWebLoading}
        retryingItemId={retryingItemId}
        setRetryingItemId={setRetryingItemId}
        onRetry={onRetry}
      />
    </article>
  );
}

function AmbientSelectedCardSections({
  item,
  selectedPrivate,
  hasPrivate,
  factsLayout,
  shouldReveal,
  revealDelay,
  revealText,
  isArticlesOnly,
  articles,
  shouldShowWebSection,
  expiredItemIds,
  isWebLoading,
  retryingItemId,
  setRetryingItemId,
  onRetry,
}: {
  item: AmbientContextViewItem;
  selectedPrivate: ReturnType<typeof ambientContextPrivateDetails>;
  hasPrivate: boolean;
  factsLayout: "bullets" | "standing";
  shouldReveal: boolean;
  revealDelay: { next: number };
  revealText: (text: string) => ReactNode;
  isArticlesOnly: boolean;
  articles: AmbientContextViewItem["citations"];
  shouldShowWebSection: boolean;
  expiredItemIds: ReadonlySet<string>;
  isWebLoading: boolean;
  retryingItemId: string | null;
  setRetryingItemId: Dispatch<SetStateAction<string | null>>;
  onRetry: (itemId: string) => Promise<void>;
}) {
  return (
    <>
      {hasPrivate ? (
        <AmbientCardPrivateSection
          selectedPrivate={selectedPrivate}
          factsLayout={factsLayout}
          shouldReveal={shouldReveal}
          revealDelay={revealDelay}
          revealText={revealText}
        />
      ) : null}
      {isArticlesOnly && articles.length !== 0 ? <AmbientCardArticlesSection articles={articles} /> : null}
      {!isArticlesOnly && shouldShowWebSection ? (
        <AmbientCardWebResearchSection
          item={item}
          hasPrivate={hasPrivate}
          factsLayout={factsLayout}
          shouldReveal={shouldReveal}
          revealDelay={revealDelay}
          revealText={revealText}
          expiredItemIds={expiredItemIds}
          isWebLoading={isWebLoading}
          retryingItemId={retryingItemId}
          setRetryingItemId={setRetryingItemId}
          onRetry={onRetry}
        />
      ) : null}
    </>
  );
}

function AmbientCardPrivateSection({
  selectedPrivate,
  factsLayout,
  shouldReveal,
  revealDelay,
  revealText,
}: {
  selectedPrivate: ReturnType<typeof ambientContextPrivateDetails>;
  factsLayout: "bullets" | "standing";
  shouldReveal: boolean;
  revealDelay: { next: number };
  revealText: (text: string) => ReactNode;
}) {
  if (selectedPrivate === null) {
    return null;
  }

  const memory = selectedPrivate.memory;
  const ashby = selectedPrivate.ashby;
  const standingCount = memory?.standing.length ?? 0;
  const ashbyFactCount = ashby?.facts.length ?? 0;

  return (
    <section
      className="live-ambient-context-research live-ambient-private-section"
      aria-label={AMBIENT_CONTEXT_PANEL_COPY.privateContextAriaLabel}
    >
      {factsLayout !== "standing" && memory !== null ? (
        <h3 className="live-ambient-standing-heading">{AMBIENT_CONTEXT_PANEL_COPY.fromYourMemory}</h3>
      ) : null}
      {memory !== null && memory.summary.length !== 0 ? (
        <p className="live-ambient-context-summary">{revealText(memory.summary.join(" "))}</p>
      ) : null}
      {standingCount + ashbyFactCount > 0 ? (
        <AmbientCardPrivateStandingFacts
          memory={memory}
          ashby={ashby}
          factsLayout={factsLayout}
          shouldReveal={shouldReveal}
          revealDelay={revealDelay}
          revealText={revealText}
        />
      ) : null}
      {ashby !== null ? (
        <div className="live-web-search-citations">
          <a
            className="live-web-search-citation has-link-arrow"
            href={ashby.profileUrl}
            target="_blank"
            rel="noreferrer"
          >
            <span>{AMBIENT_CONTEXT_PANEL_COPY.ashbyLinkLabel}</span>
            <MemoryIcon name="external" />
          </a>
        </div>
      ) : null}
    </section>
  );
}

function AmbientCardPrivateStandingFacts({
  memory,
  ashby,
  factsLayout,
  shouldReveal,
  revealDelay,
  revealText,
}: {
  memory: NonNullable<ReturnType<typeof ambientContextPrivateDetails>>["memory"];
  ashby: NonNullable<ReturnType<typeof ambientContextPrivateDetails>>["ashby"];
  factsLayout: "bullets" | "standing";
  shouldReveal: boolean;
  revealDelay: { next: number };
  revealText: (text: string) => ReactNode;
}) {
  return (
    <>
      {factsLayout === "standing" ? (
        <h3 className="live-ambient-standing-heading">{revealText(AMBIENT_CONTEXT_PANEL_COPY.whereThingsStand)}</h3>
      ) : null}
      <ul
        className={`live-web-search-reasons live-ambient-context-facts${factsLayout === "standing" ? " is-standing" : ""}`}
      >
        {[
          ...(memory?.standing ?? []).map((text) => ({ text, source: "memory" })),
          ...(ashby?.facts ?? []).map((text) => ({ text, source: "ashby" })),
        ].map(({ text, source }, factIndex) => {
          const delayMs = revealDelay.next;

          return (
            <li
              key={`${source}:${factIndex}:${text}`}
              data-source={source}
              className={shouldReveal ? "live-ambient-reveal-row" : undefined}
              style={shouldReveal ? { animationDelay: `${delayMs}ms` } : undefined}
            >
              {revealText(capitalizeBulletText(text))}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function AmbientCardArticlesSection({ articles }: { articles: AmbientContextViewItem["citations"] }) {
  return (
    <section className="live-ambient-context-research" aria-label={AMBIENT_CONTEXT_PANEL_COPY.fromTheWeb}>
      <h3 className="live-ambient-standing-heading">{AMBIENT_CONTEXT_PANEL_COPY.fromTheWeb}</h3>
      <div className="live-web-search-source-list live-ambient-article-list">
        {articles.map((article) => (
          <a key={article.url} href={article.url} target="_blank" rel="noreferrer">
            <strong>{article.title}</strong>
            <span>{article.domain ?? new URL(article.url).hostname}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

function AmbientCardWebResearchFailures({
  item,
  expiredItemIds,
  retryingItemId,
  setRetryingItemId,
  onRetry,
}: {
  item: AmbientContextViewItem;
  expiredItemIds: ReadonlySet<string>;
  retryingItemId: string | null;
  setRetryingItemId: Dispatch<SetStateAction<string | null>>;
  onRetry: (itemId: string) => Promise<void>;
}) {
  return (
    <>
      {expiredItemIds.has(item.id) ? (
        <div className="live-ambient-context-failed">
          <p>{AMBIENT_CONTEXT_PANEL_COPY.researchTakingLonger}</p>
          <button
            type="button"
            disabled={retryingItemId === item.id}
            onClick={() => {
              setRetryingItemId(item.id);
              void onRetry(item.id).finally(() => setRetryingItemId(null));
            }}
          >
            {retryingItemId === item.id
              ? AMBIENT_CONTEXT_PANEL_COPY.retryChecking
              : AMBIENT_CONTEXT_PANEL_COPY.retryTryAgain}
          </button>
        </div>
      ) : null}
      {canRetryAmbientContextResearch(item) ? (
        <div className="live-ambient-context-failed">
          <p>
            {item.status === "ready"
              ? AMBIENT_CONTEXT_PANEL_COPY.researchVerifiedFailed
              : AMBIENT_CONTEXT_PANEL_COPY.researchReadyFailed}
          </p>
          <button type="button" onClick={() => void onRetry(item.id)}>
            {AMBIENT_CONTEXT_PANEL_COPY.retryTryAgain}
          </button>
        </div>
      ) : null}
    </>
  );
}

function AmbientCardWebResearchSection({
  item,
  hasPrivate,
  factsLayout,
  shouldReveal,
  revealDelay,
  revealText,
  expiredItemIds,
  isWebLoading,
  retryingItemId,
  setRetryingItemId,
  onRetry,
}: {
  item: AmbientContextViewItem;
  hasPrivate: boolean;
  factsLayout: "bullets" | "standing";
  shouldReveal: boolean;
  revealDelay: { next: number };
  revealText: (text: string) => ReactNode;
  expiredItemIds: ReadonlySet<string>;
  isWebLoading: boolean;
  retryingItemId: string | null;
  setRetryingItemId: Dispatch<SetStateAction<string | null>>;
  onRetry: (itemId: string) => Promise<void>;
}) {
  return (
    <div className="live-ambient-context-research">
      {hasPrivate && (isWebLoading || ambientItemHasWebResult(item)) ? (
        <h3 className="live-ambient-standing-heading">{AMBIENT_CONTEXT_PANEL_COPY.fromTheWeb}</h3>
      ) : null}
      {hasPrivate && isWebLoading ? (
        <p className="live-web-search-result-meta">{AMBIENT_CONTEXT_PANEL_COPY.searchingTheWeb}</p>
      ) : null}
      <AmbientCardWebResearchFailures
        item={item}
        expiredItemIds={expiredItemIds}
        retryingItemId={retryingItemId}
        setRetryingItemId={setRetryingItemId}
        onRetry={onRetry}
      />
      {ambientItemHasWebResult(item) ? (
        <AmbientCardWebResearchBody
          item={item}
          factsLayout={factsLayout}
          shouldReveal={shouldReveal}
          revealDelay={revealDelay}
          revealText={revealText}
        />
      ) : null}
    </div>
  );
}

function AmbientCardWebResearchBody({
  item,
  factsLayout,
  shouldReveal,
  revealDelay,
  revealText,
}: {
  item: AmbientContextViewItem;
  factsLayout: "bullets" | "standing";
  shouldReveal: boolean;
  revealDelay: { next: number };
  revealText: (text: string) => ReactNode;
}) {
  return (
    <>
      {item.summary !== null && item.summary.trim().length > 0 ? (
        <p className="live-ambient-context-summary">{revealText(item.summary)}</p>
      ) : null}
      {item.facts.length !== 0 ? (
        <ul
          className={`live-web-search-reasons live-ambient-context-facts${factsLayout === "standing" ? " is-standing" : ""}`}
        >
          {item.facts.map((fact) => {
            const delayMs = revealDelay.next;

            return (
              <li
                key={fact}
                className={shouldReveal ? "live-ambient-reveal-row" : undefined}
                style={shouldReveal ? { animationDelay: `${delayMs}ms` } : undefined}
              >
                {revealText(capitalizeBulletText(fact))}
              </li>
            );
          })}
        </ul>
      ) : null}
      <span
        key={item.researchCompletedAt ?? item.updatedAt}
        className={`live-web-search-result-meta${shouldReveal ? " live-ambient-reveal-row" : ""}`}
        style={shouldReveal ? { animationDelay: `${revealDelay.next}ms` } : undefined}
      >
        {AMBIENT_CONTEXT_PANEL_COPY.updatedPrefix}
        {ambientContextUpdatedAtFormatter.format(new Date(item.researchCompletedAt ?? item.updatedAt))}
      </span>
      {item.citations.length !== 0 ? (
        <AmbientCardWebCitationDetails item={item} shouldReveal={shouldReveal} revealDelay={revealDelay} />
      ) : null}
    </>
  );
}

function AmbientCardWebCitationDetails({
  item,
  shouldReveal,
  revealDelay,
}: {
  item: AmbientContextViewItem;
  shouldReveal: boolean;
  revealDelay: { next: number };
}) {
  return (
    <>
      <div
        key={item.citations.map((citation) => citation.url).join("|")}
        className={`live-web-search-citations${shouldReveal ? " live-ambient-reveal-row" : ""}`}
        aria-label={AMBIENT_CONTEXT_PANEL_COPY.researchSourcesAriaLabel}
        style={shouldReveal ? { animationDelay: `${revealDelay.next}ms` } : undefined}
      >
        {item.citations.slice(0, AMBIENT_CONTEXT_CITATION_PREVIEW_COUNT).map((citation) => (
          <a
            key={citation.url}
            className="live-web-search-citation has-link-arrow"
            href={citation.url}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            <span>{citation.domain ?? citation.title}</span>
            <MemoryIcon name="external" />
          </a>
        ))}
      </div>
      <details
        key={shouldReveal ? `details:${item.citations.map((citation) => citation.url).join("|")}` : undefined}
        className={`live-web-search-details${shouldReveal ? " live-ambient-reveal-row" : ""}`}
        style={shouldReveal ? { animationDelay: `${revealDelay.next}ms` } : undefined}
      >
        <summary>
          <span>{AMBIENT_CONTEXT_PANEL_COPY.allSources}</span>
          <WebSearchDetailsChevron />
        </summary>
        <div className="live-web-search-source-list">
          {item.citations.map((citation) => (
            <a key={citation.url} href={citation.url} target="_blank" rel="noreferrer">
              <strong>{citation.title}</strong>
              <span>{citation.domain ?? AMBIENT_CONTEXT_PANEL_COPY.citationSourceFallback}</span>
            </a>
          ))}
        </div>
      </details>
    </>
  );
}

function WebSearchResultContent({ state }: { state: WebSearchPanelState }) {
  const answerSummary = state.answer?.summary;
  const hasAnswer = answerSummary !== undefined && answerSummary.length > 0;

  if (state.contentKind === "meeting-answer") {
    return <WebSearchMeetingAnswerContent state={state} />;
  }

  return <WebSearchGenericResultContent state={state} hasAnswer={hasAnswer} />;
}

function WebSearchMeetingAnswerContent({ state }: { state: WebSearchPanelState }) {
  if (state.status === "error") {
    return (
      <p className="live-web-search-status is-error" role="status">
        {state.message ?? AMBIENT_CONTEXT_PANEL_COPY.meetingReviewFailed}
      </p>
    );
  }
  if (state.answerDisplay !== null) {
    return (
      <>
        <WebSearchAnswerDisplayCard display={state.answerDisplay} />
        <p className="live-web-search-result-meta">
          {state.message ?? AMBIENT_CONTEXT_PANEL_COPY.meetingReviewBasedOnTranscript}
        </p>
      </>
    );
  }

  return (
    <p className="live-web-search-status" role="status">
      {state.message ?? AMBIENT_CONTEXT_PANEL_COPY.meetingReviewInProgress}
    </p>
  );
}

function WebSearchGenericErrorState({ state }: { state: WebSearchPanelState }) {
  return (
    <>
      <div className="live-web-search-status is-error" aria-live="polite">
        {webSearchStatusText({
          text: state.message ?? state.progress?.statusLabel,
          fallback: AMBIENT_CONTEXT_PANEL_COPY.webSearchUnavailable,
        })}
      </div>
      <WebSearchSourcesDetails state={state} />
    </>
  );
}

function WebSearchGenericResultContent({ state, hasAnswer }: { state: WebSearchPanelState; hasAnswer: boolean }) {
  const statusMessage = state.message;
  const hasStatusMessage = statusMessage !== null && statusMessage.length > 0;
  const answerPreview = state.answerPreview;
  const hasAnswerPreview = answerPreview !== null && answerPreview.length > 0;

  return (
    <>
      {state.status === "error" ? (
        <WebSearchGenericErrorState state={state} />
      ) : state.answerDisplay !== null ? (
        <>
          {state.status === "partial" ? (
            <div className="live-web-search-status" aria-live="polite">
              {webSearchStatusText({
                text: state.message ?? state.progress?.statusLabel,
                fallback: AMBIENT_CONTEXT_PANEL_COPY.stillCheckingSources,
              })}
            </div>
          ) : null}
          <WebSearchAnswerDisplayCard display={state.answerDisplay} />
          <WebSearchSourcesDetails state={state} />
        </>
      ) : state.status === "partial" && state.results.length === 0 ? (
        <>
          <div className="live-web-search-status" aria-live="polite">
            {webSearchStatusText({
              text: state.message ?? state.progress?.statusLabel,
              fallback: AMBIENT_CONTEXT_PANEL_COPY.stillFindingMatches,
            })}
          </div>
        </>
      ) : state.results.length === 0 && !hasAnswer ? (
        <>
          <div className="live-web-search-status" aria-live="polite">
            {AMBIENT_CONTEXT_PANEL_COPY.noReliableAnswer}
          </div>
        </>
      ) : (
        <WebSearchGenericLoadedResults
          state={state}
          statusMessage={statusMessage}
          hasStatusMessage={hasStatusMessage}
          answerPreview={answerPreview}
          hasAnswerPreview={hasAnswerPreview}
        />
      )}
    </>
  );
}

function WebSearchGenericLoadedResults({
  state,
  statusMessage,
  hasStatusMessage,
  answerPreview,
  hasAnswerPreview,
}: {
  state: WebSearchPanelState;
  statusMessage: string | null;
  hasStatusMessage: boolean;
  answerPreview: string | null;
  hasAnswerPreview: boolean;
}) {
  return (
    <>
      {state.status === "partial" && hasStatusMessage ? (
        <div className="live-web-search-status" aria-live="polite">
          {webSearchStatusText({
            text: statusMessage,
            fallback: AMBIENT_CONTEXT_PANEL_COPY.stillCheckingSources,
          })}
        </div>
      ) : null}
      {state.status === "completed" && hasStatusMessage ? (
        <div className="live-web-search-status" aria-live="polite">
          {webSearchStatusText({
            text: statusMessage,
            fallback: AMBIENT_CONTEXT_PANEL_COPY.searchCompleted,
          })}
        </div>
      ) : null}
      {state.answer === null && hasAnswerPreview ? (
        <article className="live-web-search-answer">
          <span className="live-web-search-result-meta">{AMBIENT_CONTEXT_PANEL_COPY.answerPreviewLabel}</span>
          <strong>{answerPreview}</strong>
          {state.tinyCitations.length !== 0 ? (
            <div className="live-web-search-citations" aria-label={AMBIENT_CONTEXT_PANEL_COPY.previewSourcesAriaLabel}>
              {state.tinyCitations.map((citation) => (
                <a
                  key={citation.url}
                  className="live-web-search-citation"
                  href={citation.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {citation.domain ?? citation.title}
                </a>
              ))}
            </div>
          ) : null}
        </article>
      ) : null}
      {state.answer !== null ? (
        <article className="live-web-search-answer">
          <span className="live-web-search-result-meta">{webSearchAnswerConfidenceLabel(state.answer.confidence)}</span>
          <strong>{state.answer.summary}</strong>
          {state.answer.facts.length !== 0 ? (
            <ul className="live-web-search-answer-facts">
              {state.answer.facts.map((fact) => (
                <li key={fact.text}>{capitalizeBulletText(fact.text)}</li>
              ))}
            </ul>
          ) : null}
          {state.answer.caveat !== null && state.answer.caveat.length > 0 ? <p>{state.answer.caveat}</p> : null}
          {state.answer.citations.length !== 0 ? (
            <div className="live-web-search-citations" aria-label={AMBIENT_CONTEXT_PANEL_COPY.answerSourcesAriaLabel}>
              {state.answer.citations.map((citation) => (
                <a
                  key={citation.url}
                  className="live-web-search-citation"
                  href={citation.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {citation.domain ?? citation.title}
                </a>
              ))}
            </div>
          ) : null}
        </article>
      ) : null}
      {state.results.map((result, index) => (
        <WebSearchPanelResultRow key={`${result.url}:${index}`} result={result} />
      ))}
    </>
  );
}

function WebSearchPanelResultRow({ result }: { result: VoiceWebSearchResult }) {
  if (result.kind === "source") {
    return <WebSearchSourceResultRow result={result} />;
  }

  return <WebSearchEntityResultRow result={result} />;
}

function WebSearchSourceResultRow({ result }: { result: VoiceWebSearchSourceResult }) {
  const hasPublishDate = result.publishDate !== null && result.publishDate.length > 0;

  return (
    <div className="live-web-search-result is-source">
      <span className="live-web-search-result-meta">
        {result.domain ?? AMBIENT_CONTEXT_PANEL_COPY.sourceFallback}
        {hasPublishDate ? (
          <>
            {AMBIENT_CONTEXT_PANEL_COPY.metaSeparator}
            {result.publishDate}
          </>
        ) : null}
      </span>
      <a className="live-web-search-result-title" href={result.url} target="_blank" rel="noreferrer">
        {result.title}
      </a>
      {result.excerpt.length > 0 ? <div>{result.excerpt}</div> : null}
    </div>
  );
}

function WebSearchEntityResultRow({ result }: { result: VoiceWebSearchEntityResult }) {
  const hasDomain = result.domain !== null && result.domain.length > 0;

  return (
    <article className="live-web-search-result is-entity">
      <span className="live-web-search-result-meta">
        {webSearchEntitySingularLabel(result.entityType)}
        {hasDomain ? (
          <>
            {AMBIENT_CONTEXT_PANEL_COPY.metaSeparator}
            {result.domain}
          </>
        ) : null}
      </span>
      <a className="live-web-search-result-title" href={result.url} target="_blank" rel="noreferrer">
        {result.title}
      </a>
      {result.excerpt.length > 0 ? <p>{result.excerpt}</p> : null}
      {result.reasons.length !== 0 ? (
        <ul className="live-web-search-reasons">
          {result.reasons.map((reason) => (
            <li key={reason}>{capitalizeBulletText(reason)}</li>
          ))}
        </ul>
      ) : null}
      {result.citations.length !== 0 ? (
        <div className="live-web-search-citations" aria-label={AMBIENT_CONTEXT_PANEL_COPY.sourcesDetailsLabel}>
          {result.citations.map((citation) => (
            <a
              key={citation.url}
              className="live-web-search-citation"
              href={citation.url}
              target="_blank"
              rel="noreferrer"
            >
              {citation.domain ?? citation.title}
            </a>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function webSearchEntitySingularLabel(entityType: WebSearchPanelState["entityType"]) {
  if (entityType === "person") {
    return AMBIENT_CONTEXT_PANEL_COPY.entityPerson;
  }
  if (entityType === "company") {
    return AMBIENT_CONTEXT_PANEL_COPY.entityCompany;
  }
  if (entityType === "product") {
    return AMBIENT_CONTEXT_PANEL_COPY.entityProduct;
  }

  return AMBIENT_CONTEXT_PANEL_COPY.entityDefault;
}

function capitalizeBulletText(text: string) {
  return capitalizeLeadingLetter(text);
}

function webSearchAnswerConfidenceLabel(confidence: string): string {
  return `${AMBIENT_CONTEXT_PANEL_COPY.answerConfidencePrefix} ${confidence} ${AMBIENT_CONTEXT_PANEL_COPY.answerConfidenceSuffix}`;
}

function webSearchStatusText({ text, fallback }: { text: string | null | undefined; fallback: string }) {
  const trimmed = text?.trim() ?? "";
  const resolved = trimmed.length > 0 ? trimmed : fallback;

  const sanitizedLabel = AMBIENT_CONTEXT_PANEL_COPY.webSearchSanitizedSourceLabel;

  return resolved
    .replace(/\bGoogle\s+grounded\s+search\b/gi, sanitizedLabel)
    .replace(/\bgrounded\s+Google\s+(?:AI\s+)?search\b/gi, sanitizedLabel)
    .replace(/\bGoogle\s+Search\b/gi, sanitizedLabel)
    .replace(/\bGoogle\b/gi, sanitizedLabel);
}

function WebSearchFormattedText({ text, bold }: { text: string; bold: string[] }) {
  const spans = bold.filter(
    (candidate) =>
      Boolean(candidate) && text.includes(candidate) && text.indexOf(candidate) === text.lastIndexOf(candidate),
  );
  if (spans.length === 0) {
    return <>{text}</>;
  }
  const ordered = spans
    .map((span) => ({ span, index: text.indexOf(span) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index);
  const built = ordered.reduce<{ cursor: number; nodes: ReactNode[] }>(
    (state, item) => {
      if (item.index < state.cursor) {
        return state;
      }
      const before = item.index > state.cursor ? [text.slice(state.cursor, item.index)] : [];

      return {
        cursor: item.index + item.span.length,
        nodes: [...state.nodes, ...before, <strong key={`${item.span}:${item.index}`}>{item.span}</strong>],
      };
    },
    { cursor: 0, nodes: [] },
  );
  const nodes = built.cursor < text.length ? [...built.nodes, text.slice(built.cursor)] : built.nodes;

  return <>{nodes}</>;
}

function WebSearchAnswerDisplayCard({ display }: { display: NonNullable<WebSearchPanelState["answerDisplay"]> }) {
  return (
    <article className="live-web-search-readable-answer">
      <p className="live-web-search-answer-lead">{display.lead}</p>
      {display.sections.map((section, sectionIndex) => (
        <section
          key={`${section.heading ?? AMBIENT_CONTEXT_PANEL_COPY.answerSectionKeyFallback}:${sectionIndex}`}
          className="live-web-search-answer-section"
        >
          {section.heading !== null && section.heading.length > 0 ? <h3>{section.heading}</h3> : null}
          {section.bullets.length !== 0 ? (
            <ul>
              {section.bullets.map((bullet) => (
                <li key={bullet.text}>
                  <span>
                    <WebSearchFormattedText text={capitalizeBulletText(bullet.text)} bold={bullet.bold} />
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph.text}>
              <WebSearchFormattedText text={paragraph.text} bold={paragraph.bold} />
            </p>
          ))}
        </section>
      ))}
    </article>
  );
}

function WebSearchSourcesDetails({ state }: { state: WebSearchPanelState }) {
  const displayCitations = state.answerDisplay?.citations ?? [];
  const resultSources = state.results.flatMap((result) =>
    result.kind === "source"
      ? [
          {
            title: result.title,
            url: result.url,
            domain: result.domain,
            excerpt: result.excerpt,
          },
        ]
      : [],
  );
  const sources =
    displayCitations.length !== 0
      ? displayCitations.map((citation) => ({
          title: citation.title,
          url: citation.url,
          domain: citation.domain ?? citation.label,
          excerpt: "",
        }))
      : resultSources;
  if (sources.length === 0) {
    return null;
  }

  return (
    <details className="live-web-search-details">
      <summary>
        <span>{AMBIENT_CONTEXT_PANEL_COPY.sourcesDetailsLabel}</span>
        <WebSearchDetailsChevron />
      </summary>
      <div className="live-web-search-source-list">
        {sources.slice(0, AMBIENT_CONTEXT_SOURCES_PREVIEW_COUNT).map((source) => (
          <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
            <strong>{source.title}</strong>
            <span>{source.domain ?? AMBIENT_CONTEXT_PANEL_COPY.citationSourceFallback}</span>
          </a>
        ))}
      </div>
    </details>
  );
}

function WebSearchDetailsChevron() {
  return (
    <svg className="live-web-search-details-chevron" viewBox="0 0 42.749 26.001" aria-hidden="true" focusable="false">
      <path
        d="M21.2158 26.001C21.8262 26.001 22.4365 25.7568 22.8516 25.293L41.748 5.93262C42.1631 5.51758 42.4072 4.98047 42.4072 4.37012C42.4072 3.10059 41.4551 2.12402 40.1855 2.12402C39.5752 2.12402 39.0137 2.36816 38.5986 2.75879L19.8975 21.875L22.5098 21.875L3.80859 2.75879C3.41797 2.36816 2.85645 2.12402 2.22168 2.12402C0.952148 2.12402 0 3.10059 0 4.37012C0 4.98047 0.244141 5.51758 0.65918 5.95703L19.5557 25.293C20.0195 25.7568 20.5811 26.001 21.2158 26.001Z"
        fill="currentColor"
        fillOpacity="0.85"
      />
    </svg>
  );
}

function WebSearchLoadingCard({
  phase,
  label = AMBIENT_CONTEXT_PANEL_COPY.loaderSearching,
}: {
  phase: "hidden" | "visible" | "exiting";
  label?: string;
}) {
  return (
    <div className={`live-web-search-loading is-${phase}`} role="status" aria-label={label}>
      <div className="live-web-search-loading-orb" aria-hidden="true">
        <ThinkingOrb
          state="working"
          size={64}
          theme="dark"
          className="live-web-search-loading-working-orb"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
