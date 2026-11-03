import { outlookCancellationSchema } from "../../../domain/outlook/conference";
import type { OutlookCommandEvent, OutlookOfficeHost } from "../../../ports/outlook";

import { readOfficeHost } from "./host";
import { addReadyMeeting } from "./meeting-flow";

const COMMAND_DIALOG_HEIGHT = 35;
const COMMAND_DIALOG_WIDTH = 30;
const MINUTES_PER_TIMEOUT = 10;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const COMMAND_DIALOG_TIMEOUT = MINUTES_PER_TIMEOUT * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const COMMAND_FAILURE_MESSAGE = "Could not add your Ready meeting. Please try again.";
const ERROR_DISMISS_MESSAGE = "ready-error-dismiss";

const commandError = (error: unknown): Error => (error instanceof Error ? error : new Error(COMMAND_FAILURE_MESSAGE));

const errorText = (error: Error): string => (error.message === "" ? COMMAND_FAILURE_MESSAGE : error.message);

export const showCommandError = ({
  error,
  office = readOfficeHost(),
  origin = location.origin,
}: {
  error: Error;
  office?: OutlookOfficeHost;
  origin?: string;
}): Promise<void> =>
  new Promise((resolve) => {
    if (office === undefined) {
      resolve();

      return;
    }
    const fragment = new URLSearchParams({ message: errorText(error) });
    office.context.ui.displayDialogAsync(
      `${origin}/outlook/command-error.html#${fragment}`,
      {
        height: COMMAND_DIALOG_HEIGHT,
        width: COMMAND_DIALOG_WIDTH,
        /** @external Office displayDialogAsync options contract. */
        displayInIframe: false,
      },
      (result) => {
        if (result.status !== "succeeded") {
          resolve();

          return;
        }
        const dialog = result.value;
        const settlement = { hasSettled: false };
        const timer: { id: ReturnType<typeof setTimeout> | undefined } = { id: undefined };
        const finish = (): void => {
          if (settlement.hasSettled) {
            return;
          }
          settlement.hasSettled = true;
          clearTimeout(timer.id);
          dialog.close();
          resolve();
        };
        timer.id = setTimeout(finish, COMMAND_DIALOG_TIMEOUT);
        dialog.addEventHandler(office.EventType.DialogEventReceived, finish);
        dialog.addEventHandler(office.EventType.DialogMessageReceived, (event) => {
          if (event.origin === origin && event.message === ERROR_DISMISS_MESSAGE) {
            finish();
          }
        });
      },
    );
  });

export const insertReadyMeeting = async ({
  event,
  create = addReadyMeeting,
  report = showCommandError,
}: {
  event: OutlookCommandEvent;
  create?: () => Promise<unknown>;
  report?: (input: { error: Error }) => Promise<void>;
}): Promise<void> => {
  const commandState = { canAllowEvent: false };
  try {
    await create();
    commandState.canAllowEvent = true;
  } catch (error) {
    if (!outlookCancellationSchema.safeParse(error).success) {
      try {
        await report({ error: commandError(error) });
      } catch (reportError) {
        if (reportError instanceof Error) {
          commandState.canAllowEvent = false;
        }
      }
    }
  } finally {
    event.completed({
      /** @external Outlook command completion contract */
      allowEvent: commandState.canAllowEvent,
    });
  }
};

export const initializeCommands = ({
  office,
  run = insertReadyMeeting,
}: {
  office: Pick<OutlookOfficeHost, "actions" | "onReady">;
  run?: (input: { event: OutlookCommandEvent }) => Promise<void>;
}): void => {
  office.actions.associate("insertReadyMeeting", (commandEvent) => run({ event: commandEvent }));
  office.onReady(() => undefined);
};

const office = readOfficeHost();
if (office !== undefined) {
  initializeCommands({ office });
}
