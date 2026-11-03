export type OfficeCallbackResult<T> =
  | { status: "succeeded"; value: T }
  | { status: "failed"; value?: undefined; error?: { message?: string; name?: string } };

export type OutlookCustomProperties = {
  get: (key: string) => string | null | undefined;
  set: (...args: readonly [string, string]) => void;
  saveAsync: (done: (result: OfficeCallbackResult<undefined>) => void) => void;
};

type OutlookAppointmentBody = {
  getTypeAsync: (done: (result: OfficeCallbackResult<string>) => void) => void;
  getAsync: (...args: readonly [string, (result: OfficeCallbackResult<string>) => void]) => void;
  setAsync: (
    ...args: readonly [string, { coercionType: string }, (result: OfficeCallbackResult<undefined>) => void]
  ) => void;
  prependAsync: (
    ...args: readonly [string, { coercionType: string }, (result: OfficeCallbackResult<undefined>) => void]
  ) => void;
};

export type OutlookItemIdentity = {
  getItemIdAsync?: (done: (result: OfficeCallbackResult<string>) => void) => void;
};

export type OutlookAppointmentItem = OutlookItemIdentity & {
  body: OutlookAppointmentBody;
};

type OutlookMailboxItem = OutlookAppointmentItem & {
  loadCustomPropertiesAsync?: (done: (result: OfficeCallbackResult<OutlookCustomProperties>) => void) => void;
  subject?: { getAsync: (done: (result: OfficeCallbackResult<string>) => void) => void };
};

export type OutlookDialogEvent = {
  origin?: string;
  message?: string;
};

export type OutlookDialog = {
  close: () => void;
  addEventHandler: (...args: readonly [string, (event: OutlookDialogEvent) => void]) => void;
};

type OutlookDialogOptions = {
  height: number;
  width: number;
  /** @external Office displayDialogAsync options contract. */
  displayInIframe: boolean;
};

export type OutlookCommandEvent = {
  completed: (result: {
    /** @external Outlook command completion contract */
    allowEvent: boolean;
  }) => void;
};

export type OutlookOfficeHost = {
  onReady: (callback: (info: { host: string }) => void | Promise<void>) => void;
  HostType: { Outlook: string };
  EventType: { DialogMessageReceived: string; DialogEventReceived: string };
  actions: {
    associate: (...args: readonly [string, (event: OutlookCommandEvent) => void | Promise<void>]) => void;
  };
  context: {
    mailbox: {
      item: OutlookMailboxItem;
      userProfile: { emailAddress: string };
    };
    requirements: { isSetSupported: (...args: readonly [string, string]) => boolean };
    ui: {
      displayDialogAsync: (
        ...args: readonly [string, OutlookDialogOptions, (result: OfficeCallbackResult<OutlookDialog>) => void]
      ) => void;
      messageParent: (...args: readonly [string, { targetOrigin: string }]) => void;
    };
  };
};

export type OutlookCryptoPort = {
  digestSha256: (data: Uint8Array) => Promise<ArrayBuffer>;
  randomUuid: () => string;
};
