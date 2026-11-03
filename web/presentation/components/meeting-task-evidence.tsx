"use client";

import type { MeetingAsset } from "@readymeet/shared";
import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { getMeetingAssetObjectUrl, listMeetingAssets } from "../../composition/api";

const MEETING_TASK_EVIDENCE_MODAL_TITLE = "Screen capture";
const MEETING_TASK_EVIDENCE_CLOSE_ARIA_LABEL = "Close screen capture";
const MEETING_TASK_EVIDENCE_CAPTURED_ALT = "Captured meeting screen";
const MEETING_TASK_EVIDENCE_LOADING_STATUS = "Loading capture…";
const MEETING_TASK_EVIDENCE_PREPARING_STATUS = "Preparing preview…";
const MEETING_TASK_EVIDENCE_PREVIOUS_LABEL = "Previous";
const MEETING_TASK_EVIDENCE_NEXT_LABEL = "Next";
const MEETING_TASK_EVIDENCE_LOAD_ERROR = "Could not load this capture.";
const MEETING_TASK_EVIDENCE_PAGINATION_SEPARATOR = " of ";
const MEETING_TASK_EVIDENCE_TRANSCRIPT_OPEN_QUOTE = "\u201c";
const MEETING_TASK_EVIDENCE_TRANSCRIPT_CLOSE_QUOTE = "\u201d";

function AttachmentEvidenceIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
      <path d="m4.25 4.25 7.5 7.5m0-7.5-7.5 7.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== "";
}

function useMeetingTaskEvidenceAssetList(input: {
  isOpen: boolean;
  token: string | undefined;
  meetingId: string | undefined;
  assetIdSet: Set<string>;
  setAssets: (assets: MeetingAsset[]) => void;
  setActiveIndex: (index: number | ((current: number) => number)) => void;
  setIsLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}) {
  useEffect(() => {
    if (!input.isOpen || !isNonEmptyString(input.token) || !isNonEmptyString(input.meetingId)) {
      return;
    }
    const token = input.token;
    const meetingId = input.meetingId;
    const request = { isCancelled: false };
    input.setIsLoading(true);
    input.setError(null);
    void (async () => {
      try {
        const items = await listMeetingAssets({ token, meetingId });
        if (!request.isCancelled) {
          input.setAssets(items.filter((asset) => input.assetIdSet.has(asset.id)));
          input.setActiveIndex(0);
        }
      } catch (reason) {
        if (!request.isCancelled) {
          input.setError(reason instanceof Error ? reason.message : MEETING_TASK_EVIDENCE_LOAD_ERROR);
        }
      } finally {
        if (!request.isCancelled) {
          input.setIsLoading(false);
        }
      }
    })();

    return () => {
      request.isCancelled = true;
    };
  }, [input.assetIdSet, input.isOpen, input.meetingId, input.token]);
}

function useMeetingTaskEvidenceObjectUrl(input: {
  isOpen: boolean;
  token: string | undefined;
  meetingId: string | undefined;
  activeAsset: MeetingAsset | null;
  setObjectUrl: (url: string | null) => void;
  setError: (error: string | null) => void;
}) {
  useEffect(() => {
    if (
      !input.isOpen ||
      !isNonEmptyString(input.token) ||
      !isNonEmptyString(input.meetingId) ||
      input.activeAsset === null
    ) {
      input.setObjectUrl(null);

      return;
    }
    const token = input.token;
    const meetingId = input.meetingId;
    const activeAsset = input.activeAsset;
    const request: { isCancelled: boolean; nextUrl: string | null } = { isCancelled: false, nextUrl: null };
    input.setObjectUrl(null);
    input.setError(null);
    void (async () => {
      try {
        const url = await getMeetingAssetObjectUrl({ token, meetingId, assetId: activeAsset.id });
        request.nextUrl = url;
        if (!request.isCancelled) {
          input.setObjectUrl(url);
        }
      } catch (reason) {
        if (!request.isCancelled) {
          input.setError(reason instanceof Error ? reason.message : MEETING_TASK_EVIDENCE_LOAD_ERROR);
        }
      }
    })();

    return () => {
      request.isCancelled = true;
      if (request.nextUrl !== null && request.nextUrl !== "") {
        URL.revokeObjectURL(request.nextUrl);
      }
    };
  }, [input.activeAsset?.id, input.isOpen, input.meetingId, input.token]);
}

function useMeetingTaskEvidenceEscapeClose(input: { isOpen: boolean; setIsOpen: (open: boolean) => void }) {
  useEffect(() => {
    if (!input.isOpen) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        input.setIsOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [input.isOpen, input.setIsOpen]);
}

function MeetingTaskEvidenceModal(input: {
  titleId: string;
  assets: MeetingAsset[];
  activeIndex: number;
  activeAsset: MeetingAsset | null;
  objectUrl: string | null;
  isLoading: boolean;
  error: string | null;
  setIsOpen: (open: boolean) => void;
  setActiveIndex: (index: number | ((current: number) => number)) => void;
}) {
  const transcriptExcerpt = input.activeAsset?.transcriptExcerpt;
  const hasTranscriptExcerpt =
    transcriptExcerpt !== null && transcriptExcerpt !== undefined && transcriptExcerpt !== "";
  const { objectUrl } = input;
  const hasObjectUrl = objectUrl !== null && objectUrl !== "";
  const hasError = input.error !== null && input.error !== "";

  return (
    <div
      className="meeting-evidence-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          input.setIsOpen(false);
        }
      }}
    >
      <section className="meeting-evidence-modal" role="dialog" aria-modal="true" aria-labelledby={input.titleId}>
        <header className="meeting-evidence-header">
          <div>
            <h3 id={input.titleId}>{MEETING_TASK_EVIDENCE_MODAL_TITLE}</h3>
            {input.assets.length > 1 ? (
              <p>
                {input.activeIndex + 1}
                {MEETING_TASK_EVIDENCE_PAGINATION_SEPARATOR}
                {input.assets.length}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="meeting-evidence-close"
            aria-label={MEETING_TASK_EVIDENCE_CLOSE_ARIA_LABEL}
            onClick={() => input.setIsOpen(false)}
          >
            <CloseIcon />
          </button>
        </header>
        <div className="meeting-evidence-body">
          <div className="meeting-evidence-image-shell">
            {hasObjectUrl ? (
              <img src={objectUrl} alt={MEETING_TASK_EVIDENCE_CAPTURED_ALT} />
            ) : (
              <div className={input.isLoading ? "workspace-loading-status" : "meeting-evidence-loading"} role="status">
                {input.isLoading ? MEETING_TASK_EVIDENCE_LOADING_STATUS : MEETING_TASK_EVIDENCE_PREPARING_STATUS}
              </div>
            )}
          </div>
          {hasTranscriptExcerpt ? (
            <blockquote>
              {MEETING_TASK_EVIDENCE_TRANSCRIPT_OPEN_QUOTE}
              {transcriptExcerpt}
              {MEETING_TASK_EVIDENCE_TRANSCRIPT_CLOSE_QUOTE}
            </blockquote>
          ) : null}
          {input.assets.length > 1 ? (
            <div className="meeting-evidence-footer">
              <div className="meeting-evidence-pagination">
                <button
                  type="button"
                  disabled={input.activeIndex === 0}
                  onClick={() => input.setActiveIndex((index) => index - 1)}
                >
                  {MEETING_TASK_EVIDENCE_PREVIOUS_LABEL}
                </button>
                <button
                  type="button"
                  disabled={input.activeIndex === input.assets.length - 1}
                  onClick={() => input.setActiveIndex((index) => index + 1)}
                >
                  {MEETING_TASK_EVIDENCE_NEXT_LABEL}
                </button>
              </div>
            </div>
          ) : null}
          {hasError ? <p className="meeting-evidence-error">{input.error}</p> : null}
        </div>
      </section>
    </div>
  );
}

export function MeetingTaskEvidenceMark({
  token,
  meetingId,
  assetIds,
}: {
  token?: string;
  meetingId?: string;
  assetIds: string[];
}) {
  const titleId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [assets, setAssets] = useState<MeetingAsset[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assetIdKey = assetIds.join("|");
  const activeAsset = assets[activeIndex] ?? null;
  const assetIdSet = useMemo(() => new Set(assetIds), [assetIdKey]);

  useMeetingTaskEvidenceAssetList({
    isOpen,
    token,
    meetingId,
    assetIdSet,
    setAssets,
    setActiveIndex,
    setIsLoading,
    setError,
  });
  useMeetingTaskEvidenceObjectUrl({
    isOpen,
    token,
    meetingId,
    activeAsset,
    setObjectUrl,
    setError,
  });
  useMeetingTaskEvidenceEscapeClose({ isOpen, setIsOpen });

  if (!isNonEmptyString(token) || !isNonEmptyString(meetingId) || assetIds.length === 0) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        className="workspace-task-evidence-mark"
        aria-label={`Preview ${assetIds.length === 1 ? "screen capture" : `${assetIds.length} screen captures`}`}
        onClick={() => setIsOpen(true)}
      >
        <AttachmentEvidenceIcon />
      </button>
      {isOpen && typeof document !== "undefined"
        ? createPortal(
            <MeetingTaskEvidenceModal
              titleId={titleId}
              assets={assets}
              activeIndex={activeIndex}
              activeAsset={activeAsset}
              objectUrl={objectUrl}
              isLoading={isLoading}
              error={error}
              setIsOpen={setIsOpen}
              setActiveIndex={setActiveIndex}
            />,
            document.body,
          )
        : null}
    </>
  );
}
