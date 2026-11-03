import { addon } from "../../../composition/google-calendar/addon";
import type { GoogleCalendarCallIn, GoogleCalendarErrorType } from "../../../domain/google-calendar/conference";
import { CONFERENCE_SOLUTION_ID, displayPin, phoneEntryUri } from "../../../domain/google-calendar/conference";

const REGION_CODE = "US";
const ADDON_DOCS_PATH = "/docs/google-calendar-addon";
const LINK_ONLY_WARNING = "Ready conference: no call-in returned by API; event will be link-only.";

type ConferenceEntry = {
  setEntryPointType: (value: string) => ConferenceEntry;
  setUri: (value: string) => ConferenceEntry;
  setRegionCode: (value: string) => ConferenceEntry;
  setPin: (value: string) => ConferenceEntry;
};

type ConferenceErrorBuilder = {
  setConferenceErrorType: (value: string) => ConferenceErrorBuilder;
  setAuthenticationUrl: (value: string) => ConferenceErrorBuilder;
};

type ConferenceBuilder = {
  setConferenceSolutionId: (value: string) => ConferenceBuilder;
  addEntryPoint: (entry: ConferenceEntry) => ConferenceBuilder;
  setConferenceId: (value: string) => ConferenceBuilder;
  setError: (error: ConferenceErrorBuilder) => ConferenceBuilder;
  build: () => object;
};

declare const ConferenceDataService: {
  EntryPointType: { VIDEO: string; PHONE: string };
  ConferenceErrorType: { AUTHENTICATION: string; TEMPORARY: string };
  newConferenceDataBuilder: () => ConferenceBuilder;
  newEntryPoint: () => ConferenceEntry;
  newConferenceError: () => ConferenceErrorBuilder;
};

const newBuilder = (): ConferenceBuilder =>
  ConferenceDataService.newConferenceDataBuilder().setConferenceSolutionId(CONFERENCE_SOLUTION_ID);

const videoEntry = (joinUrl: string): ConferenceEntry =>
  ConferenceDataService.newEntryPoint().setEntryPointType(ConferenceDataService.EntryPointType.VIDEO).setUri(joinUrl);

const phoneEntry = (callIn: GoogleCalendarCallIn): ConferenceEntry => {
  const entry = ConferenceDataService.newEntryPoint()
    .setEntryPointType(ConferenceDataService.EntryPointType.PHONE)
    .setUri(phoneEntryUri({ phoneNumber: callIn.phoneNumber ?? "", pin: callIn.pin }))
    .setRegionCode(REGION_CODE);
  if (callIn.pin !== undefined && callIn.pin !== null && callIn.pin !== "") {
    entry.setPin(displayPin(callIn.pin));
  }

  return entry;
};

const conferenceError = ({
  errorType,
  webBaseUrl,
}: {
  errorType: GoogleCalendarErrorType;
  webBaseUrl: string;
}): object => {
  const errorBuilder = ConferenceDataService.newConferenceError().setConferenceErrorType(
    errorType === "authentication"
      ? ConferenceDataService.ConferenceErrorType.AUTHENTICATION
      : ConferenceDataService.ConferenceErrorType.TEMPORARY,
  );
  if (errorType === "authentication") {
    errorBuilder.setAuthenticationUrl(`${webBaseUrl}${ADDON_DOCS_PATH}`);
  }

  return newBuilder().setError(errorBuilder).build();
};

const hasPhoneNumber = (
  callIn: GoogleCalendarCallIn | null | undefined,
): callIn is GoogleCalendarCallIn & { phoneNumber: string } =>
  callIn !== null &&
  callIn !== undefined &&
  callIn.phoneNumber !== undefined &&
  callIn.phoneNumber !== null &&
  callIn.phoneNumber !== "";

export const onCreateReadyConference = (event: Parameters<ReturnType<typeof addon>["createConference"]>[0]): object => {
  const flow = addon();
  const result = flow.createConference(event);
  if ("errorType" in result) {
    return conferenceError({ errorType: result.errorType, webBaseUrl: flow.webBaseUrl() });
  }
  const meetingLink = result.meetingLink;
  const joinUrl = `${flow.webBaseUrl()}/${meetingLink.code}`;
  try {
    const builder = newBuilder().addEntryPoint(videoEntry(joinUrl)).setConferenceId(meetingLink.code);
    if (hasPhoneNumber(meetingLink.callIn)) {
      builder.addEntryPoint(phoneEntry(meetingLink.callIn));
    } else {
      flow.warn(LINK_ONLY_WARNING);
    }

    return builder.build();
  } catch (error) {
    flow.error(
      `Ready conference: enriched data failed, falling back to link-only: ${error instanceof Error ? error.message : String(error)}.`,
    );

    return newBuilder().addEntryPoint(videoEntry(joinUrl)).setConferenceId(meetingLink.code).build();
  }
};
