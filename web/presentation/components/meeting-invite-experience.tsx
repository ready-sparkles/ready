"use client";

import type { MeetingInviteSuggestion } from "@readymeet/shared";
import type { KeyboardEvent, MouseEvent, RefObject } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { getApiErrorMessage, getMeetingInviteSuggestions, sendMeetingInvites } from "../../composition/api";
import {
  OPTIONAL_LIVE_REQUEST_TIMEOUT_MS,
  reportOptionalLiveServiceFailure,
} from "../lib/optional-live-feature-failure";

import { CopyStatusIcon } from "./copy-status-icon";
import { useToast } from "./toast-provider";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const CONTACT_SEARCH_DEBOUNCE_MS = 160;
const MAX_INVITE_RECIPIENTS = 10;
const MAX_CONTACT_AVATAR_INITIALS = 2;
const INVITE_COPY_FEEDBACK_MS = 2_500;

const MEETING_INVITE_EXPERIENCE_COPY = {
  meetingReadyTitle: "Your meeting’s ready",
  addOthers: "Add others",
  shareJoinLinkPrompt: "Or share this joining link with anyone you want in the meeting.",
  joinedAsLabel: "Joined as",
  contactsCouldNotLoad: "Contacts could not be loaded.",
  invitePeopleTitle: "Invite people",
  inviteRecipientLimitTitle: "Invite up to 10 people at once",
  inviteRecipientLimitMessage: "Send this group first, then invite anyone else.",
  invitationSentTitle: "Invitation sent",
  invitationsSentTitle: "Invitations sent",
  someInvitationsNotSentTitle: "Some invitations were not sent",
  invitationsNotSentTitle: "Invitations were not sent",
  tryRemainingInvitationsMessage: "Try sending the remaining invitations again.",
  tryAgainShortlyMessage: "Try again in a moment.",
  noMatches: "No matches",
  reconnectCalendarPrompt: "Reconnect Calendar to see contacts.",
  connectCalendarPrompt: "Connect Calendar to see contacts.",
  noContactsFound: "No contacts found",
  fromSenderPrefix: "From",
  meetingLinkCopiedMessage: "Ready meeting link is on your clipboard.",
  meetingLinkCopiedTitle: "Meeting link copied",
  meetingLinkNotCopiedTitle: "Meeting link not copied",
  copyLinkManuallyMessage: "Copy the link manually instead.",
  sendingLabel: "Sending…",
  sendInviteLabel: "Send invite",
} as const;

function formatSingleInviteSentMessage(email: string) {
  return `Ready invited ${email} to the meeting.`;
}

function formatMultipleInvitesSentMessage(count: number) {
  return `Ready invited ${count} people to the meeting.`;
}

function formatSendInvitesButtonLabel(count: number) {
  return `Send ${count} invites`;
}

function formatSenderLine({ senderName, senderEmail }: { senderName: string; senderEmail: string }) {
  return `${MEETING_INVITE_EXPERIENCE_COPY.fromSenderPrefix} ${senderName} · ${senderEmail}`;
}

function meetingInviteEmptyMessage({
  query,
  isReconnectNeeded,
  connectedProviderCount,
}: {
  query: string;
  isReconnectNeeded: boolean;
  connectedProviderCount: number;
}) {
  if (query !== "") {
    return MEETING_INVITE_EXPERIENCE_COPY.noMatches;
  }
  if (isReconnectNeeded) {
    return MEETING_INVITE_EXPERIENCE_COPY.reconnectCalendarPrompt;
  }
  if (connectedProviderCount === 0) {
    return MEETING_INVITE_EXPERIENCE_COPY.connectCalendarPrompt;
  }

  return MEETING_INVITE_EXPERIENCE_COPY.noContactsFound;
}

function contactDisplayInitials(contact: MeetingInviteRecipient) {
  const fromName = contact.displayName
    .split(/\s+/u)
    .filter((part) => part !== "")
    .slice(0, MAX_CONTACT_AVATAR_INITIALS)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  if (fromName !== "") {
    return fromName;
  }
  const fromEmail = contact.email[0]?.toUpperCase();
  if (fromEmail !== undefined && fromEmail !== "") {
    return fromEmail;
  }

  return "?";
}

type MeetingInviteRecipient = Pick<MeetingInviteSuggestion, "email" | "displayName" | "avatarUrl">;

function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}

export function isMeetingInviteEmail(value: string) {
  return EMAIL_PATTERN.test(normalizedEmail(value));
}

export function meetingInviteRecipientFromEmail(email: string): MeetingInviteRecipient | null {
  if (!isMeetingInviteEmail(email)) {
    return null;
  }
  const normalized = normalizedEmail(email);

  const localPart = normalized.split("@")[0];
  const displayName = localPart !== undefined && localPart !== "" ? localPart : normalized;

  return {
    email: normalized,
    displayName,
    avatarUrl: null,
  };
}

function AddPersonIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18.5 7C18.5 9.20914 16.7091 11 14.5 11C12.2909 11 10.5 9.20914 10.5 7C10.5 4.79086 12.2909 3 14.5 3C16.7091 3 18.5 4.79086 18.5 7Z" />
      <path d="M8 11C6.34315 11 5 9.65685 5 8C5 6.34315 6.34315 5 8 5" />
      <path d="M14 21H8.875C7.83947 21 7 20.1046 7 19C7 16.5 9.8125 14 14.5 14C14.6691 14 14.8358 14.0033 15 14.0096" />
      <path d="M4 19.9992H3.5C2.67157 19.9992 2 19.2317 2 18.2849C2 16.673 3.27307 15.0612 5.5 14.3613" />
      <path d="M19 15V21M16 18H22" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="m3.1 8.2 3 3 6.8-6.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ContactAvatar({ contact }: { contact: MeetingInviteRecipient }) {
  const [isImageFailed, setIsImageFailed] = useState(false);
  const initials = contactDisplayInitials(contact);
  const avatarUrl = contact.avatarUrl;
  const hasAvatarImage = avatarUrl !== null && avatarUrl !== "" && !isImageFailed;

  return (
    <span className="live-invite-contact-avatar" aria-hidden="true">
      {hasAvatarImage ? (
        <img src={avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setIsImageFailed(true)} />
      ) : (
        <span>{initials}</span>
      )}
    </span>
  );
}

function MeetingReadyInviteCard({
  joinUrl,
  joinedEmail,
  isCopied,
  onAddOthers,
  onClose,
  onCopy,
}: {
  joinUrl: string;
  joinedEmail: string;
  isCopied: boolean;
  onAddOthers: () => void;
  onClose: () => void;
  onCopy: () => void;
}) {
  return (
    <aside className="live-meeting-invite-card" aria-label="Invite people to this meeting">
      <header className="live-meeting-invite-card-header">
        <h2>{MEETING_INVITE_EXPERIENCE_COPY.meetingReadyTitle}</h2>
        <button
          type="button"
          className="live-presence-sheet-close"
          // Dismiss on press too: a panel closing on the same pointerdown can re-render the
          // chrome before the click lands, which used to drop the first dismissal.
          onPointerDown={onClose}
          onClick={onClose}
          aria-label="Close invitation card"
          title="Close"
        >
          ×
        </button>
      </header>
      <button type="button" className="live-meeting-invite-add-button" onClick={onAddOthers}>
        <AddPersonIcon />
        <span>{MEETING_INVITE_EXPERIENCE_COPY.addOthers}</span>
      </button>
      <p>{MEETING_INVITE_EXPERIENCE_COPY.shareJoinLinkPrompt}</p>
      <button type="button" className="live-meeting-invite-link" onClick={onCopy}>
        <span>{joinUrl}</span>
        <CopyStatusIcon copied={isCopied} className="live-meeting-invite-copy-icon" />
      </button>
      <small>
        {MEETING_INVITE_EXPERIENCE_COPY.joinedAsLabel} {joinedEmail}
      </small>
    </aside>
  );
}

type MeetingInviteModalProps = {
  meetingId: string;
  token: string;
  senderName: string;
  senderEmail: string;
  onClose: () => void;
  onInvitesSent: () => void;
};

function handleMeetingInviteModalInputKeyDown({
  event,
  suggestions,
  activeSuggestionIndex,
  query,
  selected,
  setActiveSuggestionIndex,
  toggleSuggestion,
  commitQuery,
  removeRecipient,
}: {
  event: KeyboardEvent<HTMLInputElement>;
  suggestions: MeetingInviteSuggestion[];
  activeSuggestionIndex: number;
  query: string;
  selected: MeetingInviteRecipient[];
  setActiveSuggestionIndex: (value: number | ((current: number) => number)) => void;
  toggleSuggestion: (suggestion: MeetingInviteSuggestion) => void;
  commitQuery: () => boolean;
  removeRecipient: (email: string) => void;
}) {
  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && suggestions.length !== 0) {
    event.preventDefault();
    setActiveSuggestionIndex((current) => {
      if (event.key === "ArrowDown") {
        return current < suggestions.length - 1 ? current + 1 : 0;
      }

      return current > 0 ? current - 1 : suggestions.length - 1;
    });

    return;
  }
  if (event.key === "Enter" && activeSuggestionIndex >= 0) {
    event.preventDefault();
    const activeSuggestion = suggestions[activeSuggestionIndex];
    if (activeSuggestion !== undefined) {
      toggleSuggestion(activeSuggestion);
    }

    return;
  }
  if (event.key === "Enter" && query.trim() !== "") {
    event.preventDefault();
    commitQuery();

    return;
  }
  if (event.key === "Backspace" && query === "" && selected.length !== 0) {
    const lastRecipient = selected.at(-1);
    if (lastRecipient !== undefined) {
      removeRecipient(lastRecipient.email);
    }
  }
}

export async function deliverMeetingInvites({
  meetingId,
  token,
  selected,
  isSending,
  setIsSending,
  setSelected,
  onInvitesSent,
  onClose,
  showToast,
}: {
  meetingId: string;
  token: string;
  selected: MeetingInviteRecipient[];
  isSending: boolean;
  setIsSending: (value: boolean) => void;
  setSelected: (
    value: MeetingInviteRecipient[] | ((current: MeetingInviteRecipient[]) => MeetingInviteRecipient[]),
  ) => void;
  onInvitesSent: () => void;
  onClose: () => void;
  showToast: ReturnType<typeof useToast>["showToast"];
}) {
  if (selected.length === 0 || isSending) {
    return;
  }
  setIsSending(true);
  try {
    const result = await sendMeetingInvites({
      token,
      meetingId,
      emails: selected.map((recipient) => recipient.email),
      signal: AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS),
    });
    if (result.sent.length !== 0) {
      onInvitesSent();
    }
    if (result.failures.length === 0) {
      const sentCount = result.sent.length;
      const firstSentEmail = result.sent[0];
      const successTitle =
        sentCount === 1
          ? MEETING_INVITE_EXPERIENCE_COPY.invitationSentTitle
          : MEETING_INVITE_EXPERIENCE_COPY.invitationsSentTitle;
      const successMessage =
        sentCount === 1 && firstSentEmail !== undefined
          ? formatSingleInviteSentMessage(firstSentEmail)
          : formatMultipleInvitesSentMessage(sentCount);
      showToast({
        id: `meeting-invites-sent:${meetingId}:${Date.now()}`,
        title: successTitle,
        message: successMessage,
        tone: "success",
      });
      onClose();

      return;
    }
    const failedEmails = new Set(result.failures.map((failure) => failure.email));
    setSelected((current) => current.filter((recipient) => failedEmails.has(recipient.email)));
    showToast({
      id: `meeting-invites-failed:${meetingId}`,
      title:
        result.sent.length !== 0
          ? MEETING_INVITE_EXPERIENCE_COPY.someInvitationsNotSentTitle
          : MEETING_INVITE_EXPERIENCE_COPY.invitationsNotSentTitle,
      message: MEETING_INVITE_EXPERIENCE_COPY.tryRemainingInvitationsMessage,
      tone: "warning",
    });
  } catch (error) {
    if (reportOptionalLiveServiceFailure({ error, feature: "invitations" })) {
      return;
    }
    showToast({
      id: `meeting-invites-error:${meetingId}`,
      title: MEETING_INVITE_EXPERIENCE_COPY.invitationsNotSentTitle,
      message: getApiErrorMessage({ error, fallback: MEETING_INVITE_EXPERIENCE_COPY.tryAgainShortlyMessage }),
      tone: "warning",
    });
  } finally {
    setIsSending(false);
  }
}

function MeetingInviteModalComposer({
  inputRef,
  selected,
  isSending,
  suggestionListId,
  suggestions,
  activeSuggestionIndex,
  query,
  setQuery,
  setActiveSuggestionIndex,
  onInputKeyDown,
  removeRecipient,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  selected: MeetingInviteRecipient[];
  isSending: boolean;
  suggestionListId: string;
  suggestions: MeetingInviteSuggestion[];
  activeSuggestionIndex: number;
  query: string;
  setQuery: (value: string) => void;
  setActiveSuggestionIndex: (value: number | ((current: number) => number)) => void;
  onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  removeRecipient: (email: string) => void;
}) {
  return (
    <div
      className={`live-invite-composer${selected.length !== 0 ? " has-recipients" : ""}`}
      onClick={() => inputRef.current?.focus()}
    >
      {selected.map((recipient) => (
        <span key={recipient.email} className="live-invite-recipient-pill">
          <ContactAvatar contact={recipient} />
          <span title={recipient.email}>{recipient.displayName}</span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              removeRecipient(recipient.email);
            }}
            aria-label={`Remove ${recipient.displayName}`}
            disabled={isSending}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        inputMode="email"
        autoComplete="off"
        role="combobox"
        aria-label="Enter name or email"
        aria-autocomplete="list"
        aria-controls={suggestionListId}
        aria-expanded={suggestions.length !== 0}
        aria-activedescendant={
          activeSuggestionIndex >= 0 ? `${suggestionListId}-option-${activeSuggestionIndex}` : undefined
        }
        placeholder={selected.length !== 0 ? "Add another" : "Enter name or email"}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveSuggestionIndex(-1);
        }}
        onKeyDown={onInputKeyDown}
        disabled={isSending}
      />
    </div>
  );
}

function syncSuggestionRowRef({
  registry,
  index,
  element,
}: {
  registry: Map<number, HTMLButtonElement>;
  index: number;
  element: HTMLButtonElement | null;
}) {
  if (element === null) {
    return new Map([...registry.entries()].filter(([key]) => key !== index));
  }

  return new Map([...[...registry.entries()].filter(([key]) => key !== index), [index, element]]);
}

function MeetingInviteModalSuggestionPanel({
  suggestions,
  suggestionListId,
  onSuggestionRowRef,
  selectedEmailSet,
  activeSuggestionIndex,
  isLoading,
  loadError,
  emptyMessage,
  isSending,
  toggleSuggestion,
}: {
  suggestions: MeetingInviteSuggestion[];
  suggestionListId: string;
  onSuggestionRowRef: (input: { index: number; element: HTMLButtonElement | null }) => void;
  selectedEmailSet: Set<string>;
  activeSuggestionIndex: number;
  isLoading: boolean;
  loadError: string | null;
  emptyMessage: string;
  isSending: boolean;
  toggleSuggestion: (suggestion: MeetingInviteSuggestion) => void;
}) {
  return (
    <div className="live-invite-suggestions" aria-live="polite" aria-busy={isLoading}>
      {suggestions.length !== 0 ? (
        <div
          id={suggestionListId}
          className="live-invite-contact-list"
          role="listbox"
          aria-label="Contacts"
          aria-multiselectable="true"
        >
          {suggestions.map((suggestion, index) => {
            const isSelected = selectedEmailSet.has(suggestion.email);
            const isKeyboardActive = activeSuggestionIndex === index;

            return (
              <button
                type="button"
                id={`${suggestionListId}-option-${index}`}
                ref={(element) => onSuggestionRowRef({ index, element })}
                role="option"
                tabIndex={-1}
                className={`live-invite-contact-row${isSelected ? " is-selected" : ""}${
                  isKeyboardActive ? " is-keyboard-active" : ""
                }`}
                key={`${suggestion.provider}:${suggestion.email}`}
                onClick={() => toggleSuggestion(suggestion)}
                aria-selected={isSelected}
                disabled={isSending}
              >
                <ContactAvatar contact={suggestion} />
                <span className="live-invite-contact-copy">
                  <strong>{suggestion.displayName}</strong>
                  <small>{suggestion.email}</small>
                </span>
                <span className="live-invite-contact-check" aria-hidden="true">
                  {isSelected ? <CheckIcon /> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : !isLoading || loadError !== null ? (
        <p className={`live-invite-empty${loadError !== null ? " is-error" : ""}`}>{loadError ?? emptyMessage}</p>
      ) : null}
    </div>
  );
}

async function loadMeetingInviteSuggestions({
  meetingId,
  token,
  query,
  signal,
}: {
  meetingId: string;
  token: string;
  query: string;
  signal: AbortSignal;
}) {
  const response = await getMeetingInviteSuggestions({
    token,
    meetingId,
    input: {
      query,
      signal,
    },
  });

  return {
    suggestions: response.suggestions,
    connectedProviderCount: response.connectedProviders.length,
    isReconnectNeeded: response.reconnectRequiredProviders.length !== 0,
  };
}

function useInviteModalEscapeToClose({ onClose, isSending }: { onClose: () => void; isSending: boolean }) {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !isSending) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSending, onClose]);
}

function useActiveSuggestionScroll({
  activeSuggestionIndex,
  suggestionRowRefs,
}: {
  activeSuggestionIndex: number;
  suggestionRowRefs: RefObject<Map<number, HTMLButtonElement>>;
}) {
  useEffect(() => {
    if (activeSuggestionIndex < 0) {
      return;
    }
    suggestionRowRefs.current.get(activeSuggestionIndex)?.scrollIntoView({ block: "nearest" });
  }, [activeSuggestionIndex, suggestionRowRefs]);
}

function useMeetingInviteSuggestionQuery({
  meetingId,
  token,
  onClose,
  isSending,
}: {
  meetingId: string;
  token: string;
  onClose: () => void;
  isSending: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const suggestionRowRefs = useRef(new Map<number, HTMLButtonElement>());
  const suggestionListId = useId();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<MeetingInviteSuggestion[]>([]);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectedProviderCount, setConnectedProviderCount] = useState(0);
  const [isReconnectNeeded, setIsReconnectNeeded] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useInviteModalEscapeToClose({ onClose, isSending });

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => {
        setIsLoading(true);
        setLoadError(null);
        void (async () => {
          try {
            const response = await loadMeetingInviteSuggestions({
              meetingId,
              token,
              query,
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(OPTIONAL_LIVE_REQUEST_TIMEOUT_MS)]),
            });
            setSuggestions(response.suggestions);
            setActiveSuggestionIndex(-1);
            setConnectedProviderCount(response.connectedProviderCount);
            setIsReconnectNeeded(response.isReconnectNeeded);
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
              return;
            }
            setSuggestions([]);
            if (reportOptionalLiveServiceFailure({ error, feature: "calendar" })) {
              setLoadError(null);

              return;
            }
            setLoadError(getApiErrorMessage({ error, fallback: MEETING_INVITE_EXPERIENCE_COPY.contactsCouldNotLoad }));
          } finally {
            if (!controller.signal.aborted) {
              setIsLoading(false);
            }
          }
        })();
      },
      query !== "" ? CONTACT_SEARCH_DEBOUNCE_MS : 0,
    );

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [meetingId, query, token]);

  useActiveSuggestionScroll({ activeSuggestionIndex, suggestionRowRefs });

  const emptyMessage = meetingInviteEmptyMessage({
    query,
    isReconnectNeeded,
    connectedProviderCount,
  });

  const onSuggestionRowRef = useCallback(({ index, element }: { index: number; element: HTMLButtonElement | null }) => {
    suggestionRowRefs.current = syncSuggestionRowRef({
      registry: new Map(suggestionRowRefs.current),
      index,
      element,
    });
  }, []);

  return {
    inputRef,
    suggestionRowRefs,
    onSuggestionRowRef,
    suggestionListId,
    query,
    setQuery,
    suggestions,
    activeSuggestionIndex,
    setActiveSuggestionIndex,
    isLoading,
    loadError,
    emptyMessage,
  };
}

function commitMeetingInviteQuery({
  query,
  suggestions,
  selectedEmailSet,
  addRecipient,
}: {
  query: string;
  suggestions: MeetingInviteSuggestion[];
  selectedEmailSet: Set<string>;
  addRecipient: (recipient: MeetingInviteRecipient) => void;
}) {
  if (isMeetingInviteEmail(query)) {
    const recipient = meetingInviteRecipientFromEmail(query);
    if (recipient === null) {
      return false;
    }
    addRecipient(recipient);

    return true;
  }
  const firstSuggestion = suggestions.find((suggestion) => !selectedEmailSet.has(suggestion.email));
  if (firstSuggestion !== undefined) {
    addRecipient(firstSuggestion);

    return true;
  }

  return false;
}

function useMeetingInviteRecipientList({
  meetingId,
  showToast,
  inputRef,
  query,
  setQuery,
  suggestions,
  activeSuggestionIndex,
  setActiveSuggestionIndex,
}: {
  meetingId: string;
  showToast: ReturnType<typeof useToast>["showToast"];
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  setQuery: (value: string) => void;
  suggestions: MeetingInviteSuggestion[];
  activeSuggestionIndex: number;
  setActiveSuggestionIndex: (value: number | ((current: number) => number)) => void;
}) {
  const [selected, setSelected] = useState<MeetingInviteRecipient[]>([]);
  const selectedEmailSet = useMemo(() => new Set(selected.map((recipient) => recipient.email)), [selected]);

  const addRecipient = useCallback(
    (recipient: MeetingInviteRecipient) => {
      const email = normalizedEmail(recipient.email);
      if (!selectedEmailSet.has(email) && selected.length >= MAX_INVITE_RECIPIENTS) {
        showToast({
          id: `meeting-invite-recipient-limit:${meetingId}`,
          title: MEETING_INVITE_EXPERIENCE_COPY.inviteRecipientLimitTitle,
          message: MEETING_INVITE_EXPERIENCE_COPY.inviteRecipientLimitMessage,
          tone: "info",
        });

        return;
      }
      setSelected((current) =>
        current.some((item) => item.email === email) ? current : [...current, { ...recipient, email }],
      );
      setQuery("");
      setActiveSuggestionIndex(-1);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    },
    [meetingId, selected.length, selectedEmailSet, showToast],
  );

  const removeRecipient = useCallback((email: string) => {
    setSelected((current) => current.filter((recipient) => recipient.email !== email));
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const toggleSuggestion = useCallback(
    (suggestion: MeetingInviteSuggestion) => {
      if (selectedEmailSet.has(suggestion.email)) {
        removeRecipient(suggestion.email);

        return;
      }
      addRecipient(suggestion);
    },
    [addRecipient, removeRecipient, selectedEmailSet],
  );

  const commitQuery = useCallback(
    () => commitMeetingInviteQuery({ query, suggestions, selectedEmailSet, addRecipient }),
    [addRecipient, query, selectedEmailSet, suggestions],
  );

  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      handleMeetingInviteModalInputKeyDown({
        event,
        suggestions,
        activeSuggestionIndex,
        query,
        selected,
        setActiveSuggestionIndex,
        toggleSuggestion,
        commitQuery,
        removeRecipient,
      });
    },
    [activeSuggestionIndex, commitQuery, query, removeRecipient, selected, suggestions, toggleSuggestion],
  );

  return {
    selected,
    setSelected,
    selectedEmailSet,
    onInputKeyDown,
    removeRecipient,
    toggleSuggestion,
  };
}

function useMeetingInviteModalState({
  meetingId,
  token,
  onClose,
  onInvitesSent,
}: Pick<MeetingInviteModalProps, "meetingId" | "token" | "onClose" | "onInvitesSent">) {
  const { showToast } = useToast();
  const [isSending, setIsSending] = useState(false);
  const suggestionQuery = useMeetingInviteSuggestionQuery({ meetingId, token, onClose, isSending });
  const recipients = useMeetingInviteRecipientList({
    meetingId,
    showToast,
    inputRef: suggestionQuery.inputRef,
    query: suggestionQuery.query,
    setQuery: suggestionQuery.setQuery,
    suggestions: suggestionQuery.suggestions,
    activeSuggestionIndex: suggestionQuery.activeSuggestionIndex,
    setActiveSuggestionIndex: suggestionQuery.setActiveSuggestionIndex,
  });

  const sendInvites = useCallback(() => {
    void deliverMeetingInvites({
      meetingId,
      token,
      selected: recipients.selected,
      isSending,
      setIsSending,
      setSelected: recipients.setSelected,
      onInvitesSent,
      onClose,
      showToast,
    });
  }, [isSending, meetingId, onClose, onInvitesSent, recipients.selected, recipients.setSelected, showToast, token]);

  const onBackdropClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && !isSending) {
        onClose();
      }
    },
    [isSending, onClose],
  );

  return {
    inputRef: suggestionQuery.inputRef,
    suggestionRowRefs: suggestionQuery.suggestionRowRefs,
    onSuggestionRowRef: suggestionQuery.onSuggestionRowRef,
    suggestionListId: suggestionQuery.suggestionListId,
    query: suggestionQuery.query,
    setQuery: suggestionQuery.setQuery,
    suggestions: suggestionQuery.suggestions,
    activeSuggestionIndex: suggestionQuery.activeSuggestionIndex,
    setActiveSuggestionIndex: suggestionQuery.setActiveSuggestionIndex,
    selected: recipients.selected,
    isLoading: suggestionQuery.isLoading,
    isSending,
    loadError: suggestionQuery.loadError,
    selectedEmailSet: recipients.selectedEmailSet,
    emptyMessage: suggestionQuery.emptyMessage,
    onInputKeyDown: recipients.onInputKeyDown,
    removeRecipient: recipients.removeRecipient,
    toggleSuggestion: recipients.toggleSuggestion,
    sendInvites,
    onBackdropClick,
  };
}

export function MeetingInviteModal({
  meetingId,
  token,
  senderName,
  senderEmail,
  onClose,
  onInvitesSent,
}: MeetingInviteModalProps) {
  const modal = useMeetingInviteModalState({ meetingId, token, onClose, onInvitesSent });

  return (
    <div className="live-invite-modal-backdrop" role="presentation" onMouseDown={modal.onBackdropClick}>
      <section className="live-invite-modal" role="dialog" aria-modal="true" aria-labelledby="live-invite-modal-title">
        <header className="live-invite-modal-header">
          <div>
            <h2 id="live-invite-modal-title">{MEETING_INVITE_EXPERIENCE_COPY.invitePeopleTitle}</h2>
          </div>
          <button
            type="button"
            className="live-presence-sheet-close"
            onClick={onClose}
            disabled={modal.isSending}
            aria-label="Close add people dialog"
            title="Close"
          >
            ×
          </button>
        </header>

        <MeetingInviteModalComposer
          inputRef={modal.inputRef}
          selected={modal.selected}
          isSending={modal.isSending}
          suggestionListId={modal.suggestionListId}
          suggestions={modal.suggestions}
          activeSuggestionIndex={modal.activeSuggestionIndex}
          query={modal.query}
          setQuery={modal.setQuery}
          setActiveSuggestionIndex={modal.setActiveSuggestionIndex}
          onInputKeyDown={modal.onInputKeyDown}
          removeRecipient={modal.removeRecipient}
        />

        <MeetingInviteModalSuggestionPanel
          suggestions={modal.suggestions}
          suggestionListId={modal.suggestionListId}
          onSuggestionRowRef={modal.onSuggestionRowRef}
          selectedEmailSet={modal.selectedEmailSet}
          activeSuggestionIndex={modal.activeSuggestionIndex}
          isLoading={modal.isLoading}
          loadError={modal.loadError}
          emptyMessage={modal.emptyMessage}
          isSending={modal.isSending}
          toggleSuggestion={modal.toggleSuggestion}
        />

        <footer className="live-invite-modal-footer">
          <div className="live-invite-sender-copy">
            <span>{formatSenderLine({ senderName, senderEmail })}</span>
          </div>
          <button
            type="button"
            className="live-invite-send-button"
            onClick={modal.sendInvites}
            disabled={modal.selected.length === 0 || modal.isSending}
          >
            {modal.isSending
              ? MEETING_INVITE_EXPERIENCE_COPY.sendingLabel
              : modal.selected.length > 1
                ? formatSendInvitesButtonLabel(modal.selected.length)
                : MEETING_INVITE_EXPERIENCE_COPY.sendInviteLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}

const INVITE_READY_DISMISSED_KEY_PREFIX = "readymeet:invite-ready-dismissed:";

function readInviteReadyDismissed(meetingId: string): boolean {
  try {
    return window.sessionStorage.getItem(INVITE_READY_DISMISSED_KEY_PREFIX + meetingId) === "1";
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return false;
  }
}

function writeInviteReadyDismissed(input: { meetingId: string; isDismissed: boolean }): void {
  try {
    const key = INVITE_READY_DISMISSED_KEY_PREFIX + input.meetingId;
    if (input.isDismissed) {
      window.sessionStorage.setItem(key, "1");
    } else {
      window.sessionStorage.removeItem(key);
    }
  } catch (error) {
    // Storage can be unavailable (private mode); dismissal then lasts for this mount only.
    if (!(error instanceof Error)) {
      throw error;
    }
  }
}

function useInviteReadyDismissal(meetingId: string) {
  const [isDismissed, setIsDismissedState] = useState(() => readInviteReadyDismissed(meetingId));
  // Persist per meeting: the card unmounts with the live chrome, and a local flag alone
  // made it reappear after every remount.
  const setIsDismissed = useCallback(
    (isNextDismissed: boolean) => {
      setIsDismissedState(isNextDismissed);
      writeInviteReadyDismissed({ meetingId, isDismissed: isNextDismissed });
    },
    [meetingId],
  );

  return { isDismissed, setIsDismissed, setIsDismissedState };
}

export function MeetingInviteExperience({
  meetingId,
  joinUrl,
  token,
  senderName,
  senderEmail,
  isVisible,
}: {
  meetingId: string;
  joinUrl: string;
  token: string;
  senderName: string;
  senderEmail: string;
  isVisible: boolean;
}) {
  const { showToast } = useToast();
  const { isDismissed, setIsDismissed, setIsDismissedState } = useInviteReadyDismissal(meetingId);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    setIsDismissedState(readInviteReadyDismissed(meetingId));
    setIsModalOpen(false);
    setIsCopied(false);
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
  }, [meetingId]);

  useEffect(() => {
    if (!isVisible) {
      setIsModalOpen(false);
    }
  }, [isVisible]);

  const copyJoinUrl = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setIsCopied(true);
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => setIsCopied(false), INVITE_COPY_FEEDBACK_MS);
      showToast({
        id: `meeting-invite-link-copied:${meetingId}`,
        title: MEETING_INVITE_EXPERIENCE_COPY.meetingLinkCopiedTitle,
        message: MEETING_INVITE_EXPERIENCE_COPY.meetingLinkCopiedMessage,
        tone: "success",
      });
    } catch (error) {
      showToast({
        id: `meeting-invite-link-error:${meetingId}`,
        title: MEETING_INVITE_EXPERIENCE_COPY.meetingLinkNotCopiedTitle,
        message: getApiErrorMessage({ error, fallback: MEETING_INVITE_EXPERIENCE_COPY.copyLinkManuallyMessage }),
        tone: "warning",
      });
    }
  };

  if (!isVisible) {
    return null;
  }

  return (
    <>
      {!isDismissed && !isModalOpen ? (
        <MeetingReadyInviteCard
          joinUrl={joinUrl}
          joinedEmail={senderEmail}
          isCopied={isCopied}
          onAddOthers={() => setIsModalOpen(true)}
          onClose={() => setIsDismissed(true)}
          onCopy={() => void copyJoinUrl()}
        />
      ) : null}
      {isModalOpen ? (
        <MeetingInviteModal
          key={meetingId}
          meetingId={meetingId}
          token={token}
          senderName={senderName}
          senderEmail={senderEmail}
          onClose={() => setIsModalOpen(false)}
          onInvitesSent={() => setIsDismissed(true)}
        />
      ) : null}
    </>
  );
}
