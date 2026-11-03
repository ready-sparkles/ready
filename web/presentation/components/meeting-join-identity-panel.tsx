"use client";

import { GuestRecognitionChoice, type GuestRecognitionControl, MeetingMemoryNotice } from "./guest-recognition";

const MAX_DISPLAY_NAME_LENGTH = 60;

type Props = {
  user: { displayName: string; email: string } | null;
  displayName: string;
  onDisplayNameChange: (name: string) => void;
  recognition: GuestRecognitionControl;
  isAskingToJoin: boolean;
  canAskToJoin: boolean;
  onAskToJoin: () => void;
};

/** Shared by the real prejoin flow and the isolated waiting-room preview. */
export function MeetingJoinIdentityPanel({
  user,
  displayName,
  onDisplayNameChange,
  recognition,
  isAskingToJoin,
  canAskToJoin,
  onAskToJoin,
}: Props) {
  return (
    <>
      <div className="meeting-join-heading">
        <h1 className="meeting-join-heading-title">{user ? "Ready to join?" : "Your name"}</h1>
      </div>
      {user ? (
        <div className="meeting-join-identity">
          <span>{user.displayName[0]?.toUpperCase()}</span>
          <div>
            <strong>{user.displayName}</strong>
            <small>{user.email}</small>
          </div>
        </div>
      ) : (
        <label className="meeting-join-name-field" aria-label="Your name">
          <input
            className="settings-profile-name-input"
            value={displayName}
            onChange={(event) => onDisplayNameChange(event.target.value.slice(0, MAX_DISPLAY_NAME_LENGTH))}
            maxLength={MAX_DISPLAY_NAME_LENGTH}
            placeholder="Your name"
          />
        </label>
      )}
      {!user ? <GuestRecognitionChoice control={recognition} disabled={isAskingToJoin} /> : null}
      <MeetingMemoryNotice />
      <button
        className="meeting-join-primary-button"
        type="button"
        disabled={!canAskToJoin || isAskingToJoin || (!user && recognition.busy)}
        onClick={onAskToJoin}
      >
        Ask to join
      </button>
    </>
  );
}
