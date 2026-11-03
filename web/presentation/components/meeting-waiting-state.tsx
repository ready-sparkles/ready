"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { GUEST_MEETING_REJOIN_DELAY_MS } from "../../composition/guest-notes-transition";

const MAX_WAITING_CONCLUSIONS = 11;

export const GUEST_WAITING_FINAL_LINE = "Your notes will appear here when the conversation ends.";

const MEETING_REJOIN_BANNER_TITLE = "The conversation is still going";
const MEETING_REJOIN_BANNER_BODY = "There’s more being discussed. You can jump back in at any time.";
const MEETING_REJOIN_ACTION_LABEL = "Rejoin meeting";

export function useMeetingWaitingState(input: { isInProgress: boolean; conclusions: string[] }) {
  const [isRejoinPromptVisible, setIsRejoinPromptVisible] = useState(false);
  const [waitingConclusions, setWaitingConclusions] = useState<string[]>([]);
  useEffect(() => {
    if (input.isInProgress && input.conclusions.length !== 0) {
      setWaitingConclusions((current) => (current.length !== 0 ? current : input.conclusions));
    }
  }, [input.conclusions, input.isInProgress]);
  useEffect(() => {
    setIsRejoinPromptVisible(false);
    if (!input.isInProgress) {
      setWaitingConclusions([]);

      return;
    }
    const timer = window.setTimeout(() => setIsRejoinPromptVisible(true), GUEST_MEETING_REJOIN_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [input.isInProgress]);
  const waitingLines = useMemo(
    () => [...waitingConclusions.slice(0, MAX_WAITING_CONCLUSIONS), GUEST_WAITING_FINAL_LINE],
    [waitingConclusions],
  );

  return { waitingLines, isShowRejoin: input.isInProgress && isRejoinPromptVisible };
}

export function MeetingRejoinBanner({ meetingId }: { meetingId: string }) {
  return (
    <aside className="guest-notes-banner guest-notes-rejoin workspace-flow-reveal">
      <div>
        <h3>{MEETING_REJOIN_BANNER_TITLE}</h3>
        <p>{MEETING_REJOIN_BANNER_BODY}</p>
      </div>
      <Link className="workspace-setup-action" href={`/meetings/${meetingId}/live`} prefetch={false}>
        {MEETING_REJOIN_ACTION_LABEL}
      </Link>
    </aside>
  );
}
