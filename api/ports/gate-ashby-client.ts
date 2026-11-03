/* eslint-disable policy/named-parameters -- These signatures mirror the existing adapter contract. */
import { bindPortFunction } from "./bind-port";

const ASHBY_CLIENT_PORT_IS_NOT_CONFIGURED_MESSAGE = "AshbyClient port is not configured.";

/** An application as returned by application.info; only the fields Ready shows. */
export type AshbyApplication = {
  id: string;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  candidate?: { id: string } | null;
  job?: { id?: string; title?: string | null } | null;
  currentInterviewStage?: { id?: string; title?: string | null; type?: string; interviewPlanId?: string } | null;
  source?: { title?: string | null } | null;
  archiveReason?: { text?: string | null } | null;
  hiringTeam?: { firstName?: string | null; lastName?: string | null; role?: string | null }[];
};

/** A candidate as returned by candidate.search; only the fields Ready reads. */
export type AshbyCandidate = {
  id: string;
  name: string;
  primaryEmailAddress?: { value: string } | null;
  emailAddresses?: { value: string }[];
  profileUrl?: string | null;
  applicationIds?: string[];
};

type AshbyEnvelope<T> = {
  /** @external ashby envelope success wire field */
  success?: boolean;
  results?: T;
  /** @external ashby envelope more data available wire field */
  moreDataAvailable?: boolean;
  nextCursor?: string | null;
  errors?: (string | { message?: string })[];
  errorInfo?: { code?: string; message?: string };
};

type AshbyClientOptions = {
  fetch?: typeof fetch;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
};

type AshbyClientPort = {
  createAshbyClient: (...args: [apiKey: string, options?: AshbyClientOptions]) => {
    call: <T>(endpoint: string, body?: Record<string, unknown>, shouldRetry?: boolean) => Promise<AshbyEnvelope<T>>;
    write<T>(endpoint: string, body: Record<string, unknown>): Promise<AshbyEnvelope<T>>;
    searchCandidates(query: { email: string } | { name: string }): Promise<AshbyCandidate[]>;
    application(applicationId: string): Promise<AshbyApplication | null>;
  };
};

const ashbyClientState: { port?: AshbyClientPort } = {};

export function configureAshbyClient(port: AshbyClientPort): void {
  ashbyClientState.port = port;
}

function ashbyClient(): AshbyClientPort {
  if (ashbyClientState.port === undefined) {
    throw new Error(ASHBY_CLIENT_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return ashbyClientState.port;
}

export const createAshbyClient: AshbyClientPort["createAshbyClient"] = bindPortFunction(
  () => ashbyClient().createAshbyClient,
);

export type AshbyClient = {
  call: <T>(endpoint: string, body?: Record<string, unknown>, shouldRetry?: boolean) => Promise<AshbyEnvelope<T>>;
  write: <T>(endpoint: string, body: Record<string, unknown>) => Promise<AshbyEnvelope<T>>;
  searchCandidates: (query: { email: string } | { name: string }) => Promise<AshbyCandidate[]>;
  application: (applicationId: string) => Promise<AshbyApplication | null>;
};
