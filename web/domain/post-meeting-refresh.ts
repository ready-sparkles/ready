type PostMeetingRefreshResult<TMeeting, TDetail> =
  | { kind: "loaded"; meetings: TMeeting[]; detail: TDetail }
  | { kind: "unavailable"; meetings: TMeeting[]; error: unknown };

/**
 * Loads the meeting list and the selected meeting together. A selected meeting
 * that does not exist or is not visible (403/404) is a normal "not found"
 * state, not a failure: the list still loads and the caller shows its
 * not-found view. Any other failure still rejects.
 */
export async function loadPostMeetingRefresh<TMeeting, TDetail>(input: {
  listMeetings: () => Promise<TMeeting[]>;
  getMeeting: () => Promise<TDetail>;
  isMeetingUnavailable: (error: unknown) => boolean;
}): Promise<PostMeetingRefreshResult<TMeeting, TDetail>> {
  const selected = (async () => {
    try {
      return { kind: "loaded" as const, detail: await input.getMeeting() };
    } catch (error: unknown) {
      if (input.isMeetingUnavailable(error)) {
        return { kind: "unavailable" as const, error };
      }
      throw error;
    }
  })();
  const [meetings, selection] = await Promise.all([input.listMeetings(), selected]);

  return selection.kind === "loaded"
    ? { kind: "loaded", meetings, detail: selection.detail }
    : { kind: "unavailable", meetings, error: selection.error };
}
