import type { OutlookOfficeHost } from "../../../ports/outlook";

type OfficeOnReady = OutlookOfficeHost["onReady"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isOnReady = (value: unknown): value is OfficeOnReady => typeof value === "function";

const readGlobalOffice = (): Record<string, unknown> | undefined => {
  const host: unknown = globalThis;
  if (!isRecord(host) || !("Office" in host)) {
    return undefined;
  }
  const office: unknown = host.Office;

  return isRecord(office) ? office : undefined;
};

// Dialog and taskpane start from onReady alone. The command runtime needs the fuller host.
export const readOfficeOnReady = (): OfficeOnReady | undefined => {
  const office = readGlobalOffice();
  if (office === undefined) {
    return undefined;
  }
  const onReady: unknown = office.onReady;

  return isOnReady(onReady) ? onReady : undefined;
};

const isOfficeHost = (value: Record<string, unknown>): value is OutlookOfficeHost =>
  "context" in value && "onReady" in value && "HostType" in value && "EventType" in value;

export const readOfficeHost = (): OutlookOfficeHost | undefined => {
  const office = readGlobalOffice();
  if (office === undefined || !isOfficeHost(office)) {
    return undefined;
  }

  return office;
};

export const hasWebCrypto = (): boolean => {
  const cryptoApi: unknown = globalThis.crypto;
  if (!isRecord(cryptoApi)) {
    return false;
  }

  return (
    "randomUUID" in cryptoApi &&
    typeof cryptoApi.randomUUID === "function" &&
    "subtle" in cryptoApi &&
    isRecord(cryptoApi.subtle)
  );
};
