"use client";

const PRIVATE_BETA_JOINED_TITLE = "You're on the waitlist";
const PRIVATE_BETA_JOIN_TITLE = "Join waitlist";
const PRIVATE_BETA_JOINED_BODY = "Thanks. We'll let you know when hosting access is ready for your account.";
const PRIVATE_BETA_DEFAULT_BODY =
  "Ready is in private beta. Join the waitlist to request access to host AI-assisted meetings.";
const PRIVATE_BETA_CLOSE_LABEL = "Close private beta application";
const PRIVATE_BETA_EYEBROW = "Private beta";
const PRIVATE_BETA_FOLLOW_LABEL = "Follow on X";
const PRIVATE_BETA_BACK_LABEL = "Back";
const PRIVATE_BETA_JOINING_LABEL = "Joining";
const PRIVATE_BETA_JOIN_NOW_LABEL = "Join now";
const PRIVATE_BETA_CLOSE_SYMBOL = "×";

export function PrivateBetaApplicationModal({
  body,
  error,
  isJoined,
  isJoining,
  joinLabel,
  onJoin,
  onClose,
}: {
  /** Overrides the not-yet-joined body copy for context-specific prompts. */
  body?: string;
  error: string | null;
  isJoined: boolean;
  isJoining: boolean;
  /** Overrides the join button label (e.g. when joining requires sign-in). */
  joinLabel?: string;
  onJoin: () => void;
  onClose: () => void;
}) {
  const title = isJoined ? PRIVATE_BETA_JOINED_TITLE : PRIVATE_BETA_JOIN_TITLE;
  const resolvedBody = isJoined ? PRIVATE_BETA_JOINED_BODY : (body ?? PRIVATE_BETA_DEFAULT_BODY);
  const hasError = error !== null && error.length > 0;

  return (
    <>
      <button
        className="private-beta-application-backdrop"
        type="button"
        aria-label={PRIVATE_BETA_CLOSE_LABEL}
        onClick={onClose}
      />
      <section
        className="private-beta-application-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="private-beta-title"
      >
        <button
          className="workspace-settings-modal-close private-beta-application-close"
          type="button"
          aria-label={PRIVATE_BETA_CLOSE_LABEL}
          onClick={onClose}
        >
          <span>{PRIVATE_BETA_CLOSE_SYMBOL}</span>
        </button>
        <p>{PRIVATE_BETA_EYEBROW}</p>
        <h1 id="private-beta-title">{title}</h1>
        <span>{resolvedBody}</span>
        {hasError ? <strong className="private-beta-application-error">{error}</strong> : null}
        <div className="private-beta-application-actions">
          {isJoined ? (
            <a
              className="private-beta-application-primary"
              href="https://x.com/readymeetai"
              target="_blank"
              rel="noreferrer"
            >
              {PRIVATE_BETA_FOLLOW_LABEL}
            </a>
          ) : (
            <>
              <button type="button" onClick={onClose}>
                {PRIVATE_BETA_BACK_LABEL}
              </button>
              <button className="private-beta-application-primary" type="button" onClick={onJoin} disabled={isJoining}>
                {isJoining ? PRIVATE_BETA_JOINING_LABEL : (joinLabel ?? PRIVATE_BETA_JOIN_NOW_LABEL)}
              </button>
            </>
          )}
        </div>
      </section>
    </>
  );
}
