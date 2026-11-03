import type { ProviderAccountStatus } from "@readymeet/shared";

export type ProviderAccountLoadScope = {
  requestId: number;
  token: string;
  userId: string;
};

export function isCurrentProviderAccountLoad(input: {
  request: ProviderAccountLoadScope;
  current: ProviderAccountLoadScope | null;
}): boolean {
  return (
    input.current !== null &&
    input.request.requestId === input.current.requestId &&
    input.request.token === input.current.token &&
    input.request.userId === input.current.userId
  );
}

export function providerAccountsForUser<T extends { userId: string }>(input: { accounts: T[]; userId: string }): T[] {
  return input.accounts.filter((account) => account.userId === input.userId);
}

export function calendarAccountStatusCopy(status: ProviderAccountStatus): string {
  if (status === "connected") {
    return "Connected";
  }
  if (status === "error") {
    return "Connection problem — reconnect to show events";
  }

  return "Disconnected — reconnect to show events";
}
