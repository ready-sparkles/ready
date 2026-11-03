export const MEETING_TITLE_TRANSCRIPT_REQUIRED_CODE = "meeting_title_transcript_required";
export const MEETING_TITLE_TRANSCRIPT_REQUIRED_MESSAGE = "Meeting title generation requires human transcript content";

/**
 * A meeting with no human speech has nothing to title. This is an expected
 * outcome (a missed connection, an instant hang-up), not a service failure:
 * the assistant answers 422 with this code and the API keeps the current title.
 */
export class MeetingTitleTranscriptRequired extends Error {
  readonly code = MEETING_TITLE_TRANSCRIPT_REQUIRED_CODE;

  constructor() {
    super(MEETING_TITLE_TRANSCRIPT_REQUIRED_MESSAGE);
    this.name = "MeetingTitleTranscriptRequired";
  }
}
