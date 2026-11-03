import { bindPortFunction } from "./bind-port";

const CALENDAR_DESCRIPTION_BLOCKS_PORT_IS_NOT_CONFIGURED_MESSAGE = "CalendarDescriptionBlocks port is not configured.";

type CalendarDescriptionBlocksPort = {
  replaceReadyDescriptionBlocks: (
    ...args: [source: string, replacement: string, isReadyUrl: (url: string) => boolean]
  ) => string | null;
};

const calendarDescriptionBlocksState: { port?: CalendarDescriptionBlocksPort } = {};

export function configureCalendarDescriptionBlocks(port: CalendarDescriptionBlocksPort): void {
  calendarDescriptionBlocksState.port = port;
}

function calendarDescriptionBlocks(): CalendarDescriptionBlocksPort {
  if (calendarDescriptionBlocksState.port === undefined) {
    throw new Error(CALENDAR_DESCRIPTION_BLOCKS_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return calendarDescriptionBlocksState.port;
}

export const replaceReadyDescriptionBlocks: CalendarDescriptionBlocksPort["replaceReadyDescriptionBlocks"] =
  bindPortFunction(() => calendarDescriptionBlocks().replaceReadyDescriptionBlocks);
