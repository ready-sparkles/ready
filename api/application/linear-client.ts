import { z } from "zod";

import { apiEnv } from "../ports/api-env";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_OAUTH_AUTHORIZE_URL = "https://linear.app/oauth/authorize";

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const SECONDS_PER_DAY = HOURS_PER_DAY * SECONDS_PER_HOUR;
const LINEAR_DEFAULT_TOKEN_EXPIRES_SECONDS = SECONDS_PER_DAY - 1;
const MILLISECONDS_PER_SECOND = 1000;
const OAUTH_TOKEN_TYPE_BEARER = "Bearer";

const LINEAR_TEAMS_QUERY_FIRST = 20;
const LINEAR_SEARCH_ISSUES_FIRST = 8;
const DEFAULT_LINEAR_ISSUES_LIMIT = 8;
const LINEAR_SAMPLE_TEAM_ISSUES_FIRST = 10;

const LINEAR_UPLOAD_ERROR_CODE_MAX_LENGTH = 120;
const UPLOAD_CACHE_MAX_AGE_SECONDS = 31_536_000;
const UPLOAD_CACHE_CONTROL_PREFIX = "public, max-age=";

const MESSAGE_LINEAR_OAUTH_NOT_CONFIGURED = "Linear OAuth is not configured";
const MESSAGE_LINEAR_TOKEN_EXCHANGE_FAILED_PREFIX = "Linear token exchange failed: ";
const MESSAGE_LINEAR_TOKEN_REFRESH_FAILED_PREFIX = "Linear token refresh failed: ";
const MESSAGE_LINEAR_GRAPHQL_REQUEST_FAILED_PREFIX = "Linear GraphQL request failed (";
const MESSAGE_LINEAR_GRAPHQL_REQUEST_FAILED_SUFFIX = ")";
const MESSAGE_LINEAR_GRAPHQL_ERROR_SEPARATOR = "; ";
const MESSAGE_LINEAR_ISSUE_RELATION_MISMATCH = "Linear issue relation ID belongs to a different relation";
const MESSAGE_LINEAR_FILE_UPLOAD_NO_DESTINATION = "Linear fileUpload returned no upload destination";
const MESSAGE_LINEAR_FILE_UPLOAD_FAILED_PREFIX = "Linear file upload failed (";
const MESSAGE_LINEAR_FILE_UPLOAD_FAILED_CODE_SEPARATOR = ": ";
const MESSAGE_LINEAR_FILE_UPLOAD_FAILED_SUFFIX = ")";

const LINEAR_OAUTH_SCOPES = "read,write,issues:create,comments:create";

export type LinearTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string;
  tokenType: string;
};

export class LinearFileUploadError extends Error {
  readonly code = "linear_file_upload_failed";
  readonly status: number;
  readonly providerCode: string | null;

  constructor(...args: [status: number, providerCode: string | null]) {
    const status = args[0];
    const providerCode = args[1];
    super(formatLinearFileUploadErrorMessage({ status, providerCode }));
    this.name = "LinearFileUploadError";
    this.status = status;
    this.providerCode = providerCode;
  }
}

type LinearOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

type LinearIssueRelation = {
  id: string;
  type: string;
  issue: { id: string };
  relatedIssue: { id: string };
};

type LinearIssueRelationCreateResult = {
  issueRelationCreate: {
    /** @external linear issueRelationCreate success */
    success: boolean;
    issueRelation: LinearIssueRelation;
  };
};

const linearOAuthTokenResponseSchema = z
  .object({
    access_token: z.unknown().optional(),
    refresh_token: z.unknown().optional(),
    expires_in: z.number().optional(),
    token_type: z.unknown().optional(),
    scope: z.union([z.string(), z.array(z.unknown())]).optional(),
  })
  .passthrough();

const linearGraphqlErrorSchema = z.object({
  message: z.string().optional(),
});

const linearGraphqlEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(linearGraphqlErrorSchema).optional(),
});

const linearIssueStateSchema = z
  .object({
    name: z.string(),
  })
  .passthrough()
  .nullable()
  .optional();

const linearIssueSummarySchema = z
  .object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    url: z.string(),
    description: z.string().nullable().optional(),
    state: linearIssueStateSchema,
  })
  .passthrough();

const linearIssueWithPeopleSchema = linearIssueSummarySchema.extend({
  assignee: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .passthrough()
    .nullable()
    .optional(),
  creator: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .passthrough()
    .nullable()
    .optional(),
});

const linearIssueRelationSchema = z.object({
  id: z.string(),
  type: z.string(),
  issue: z.object({ id: z.string() }).passthrough(),
  relatedIssue: z.object({ id: z.string() }).passthrough(),
});

const linearViewerResponseSchema = z.object({
  viewer: z
    .object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
    })
    .passthrough(),
});

const linearTeamsResponseSchema = z.object({
  teams: z.object({
    nodes: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          key: z.string(),
        })
        .passthrough(),
    ),
  }),
});

const linearIssuesSearchResponseSchema = z.object({
  issues: z.object({
    nodes: z.array(linearIssueSummarySchema),
  }),
});

const linearIssueResponseSchema = z.object({
  issue: linearIssueSummarySchema.nullable(),
});

const linearIssuesListResponseSchema = z.object({
  issues: z.object({
    nodes: z.array(linearIssueSummarySchema),
  }),
});

const linearViewerAssignedIssuesResponseSchema = z.object({
  viewer: z.object({
    assignedIssues: z.object({
      nodes: z.array(linearIssueSummarySchema),
    }),
  }),
});

const linearViewerCreatedIssuesResponseSchema = z.object({
  issues: z.object({
    nodes: z.array(linearIssueWithPeopleSchema),
  }),
});

const linearSampleIssuesResponseSchema = z.object({
  team: z
    .object({
      issues: z.object({
        nodes: z.array(
          z
            .object({
              id: z.string(),
              identifier: z.string(),
              title: z.string(),
              description: z.string().nullable().optional(),
              labels: z.object({
                nodes: z.array(z.object({ name: z.string() }).passthrough()),
              }),
            })
            .passthrough(),
        ),
      }),
    })
    .nullable(),
});

const linearIssueCreateResponseSchema = z.object({
  issueCreate: z.object({
    /** @external linear issueCreate success */
    success: z.boolean(),
    issue: z
      .object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        url: z.string(),
        createdAt: z.string(),
        team: z.object({ id: z.string() }).passthrough(),
      })
      .passthrough()
      .nullable(),
  }),
});

const linearIssueUpdateResponseSchema = z.object({
  issueUpdate: z.object({
    /** @external linear issueUpdate success */
    success: z.boolean(),
    issue: z
      .object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        url: z.string(),
      })
      .passthrough()
      .nullable(),
  }),
});

const linearIssueRelationResponseSchema = z.object({
  issueRelation: linearIssueRelationSchema.nullable(),
});

const linearIssueRelationCreateResponseSchema = z.object({
  issueRelationCreate: z.object({
    /** @external linear issueRelationCreate success */
    success: z.boolean(),
    issueRelation: linearIssueRelationSchema.nullable(),
  }),
});

type LinearIssuesSearchResponse = z.infer<typeof linearIssuesSearchResponseSchema>;
type LinearIssueResponse = z.infer<typeof linearIssueResponseSchema>;
type LinearIssuesListResponse = z.infer<typeof linearIssuesListResponseSchema>;
type LinearViewerAssignedIssuesResponse = z.infer<typeof linearViewerAssignedIssuesResponseSchema>;
type LinearViewerCreatedIssuesResponse = z.infer<typeof linearViewerCreatedIssuesResponseSchema>;
type LinearSampleIssuesResponse = z.infer<typeof linearSampleIssuesResponseSchema>;
type LinearIssueCreateResponse = z.infer<typeof linearIssueCreateResponseSchema>;
type LinearIssueUpdateResponse = z.infer<typeof linearIssueUpdateResponseSchema>;

type CreateLinearIssueRelationResponse =
  | LinearIssueRelationCreateResult
  | z.infer<typeof linearIssueRelationCreateResponseSchema>;

const linearFileUploadResponseSchema = z.object({
  fileUpload: z
    .object({
      /** @external linear fileUpload success */
      success: z.boolean(),
      uploadFile: z
        .object({
          uploadUrl: z.string(),
          assetUrl: z.string(),
          headers: z.array(
            z
              .object({
                key: z.string(),
                value: z.string(),
              })
              .passthrough(),
          ),
        })
        .passthrough()
        .nullable(),
    })
    .passthrough()
    .nullable(),
});

function formatLinearFileUploadErrorMessage(input: { status: number; providerCode: string | null }): string {
  const codeSuffix =
    input.providerCode !== null && input.providerCode !== ""
      ? `${MESSAGE_LINEAR_FILE_UPLOAD_FAILED_CODE_SEPARATOR}${input.providerCode}`
      : "";

  return `${MESSAGE_LINEAR_FILE_UPLOAD_FAILED_PREFIX}${input.status}${codeSuffix}${MESSAGE_LINEAR_FILE_UPLOAD_FAILED_SUFFIX}`;
}

function formatLinearTokenOperationFailedMessage(input: { prefix: string; detail: string }): string {
  return `${input.prefix}${input.detail}`;
}

function formatLinearGraphqlRequestFailedMessage(input: { status: number }): string {
  return `${MESSAGE_LINEAR_GRAPHQL_REQUEST_FAILED_PREFIX}${input.status}${MESSAGE_LINEAR_GRAPHQL_REQUEST_FAILED_SUFFIX}`;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTokenScope(input: { scope: unknown }): string {
  if (Array.isArray(input.scope)) {
    return input.scope.map(String).join(" ");
  }
  const scope = readNonEmptyString(input.scope);

  return scope ?? "";
}

function readLinearOAuthConfig(): LinearOAuthConfig {
  const clientId = readNonEmptyString(apiEnv().LINEAR_CLIENT_ID);
  const clientSecret = readNonEmptyString(apiEnv().LINEAR_CLIENT_SECRET);
  const redirectUri = readNonEmptyString(apiEnv().LINEAR_REDIRECT_URI);
  if (clientId === null || clientSecret === null || redirectUri === null) {
    throw new Error(MESSAGE_LINEAR_OAUTH_NOT_CONFIGURED);
  }

  return { clientId, clientSecret, redirectUri };
}

export function buildLinearAuthorizationUrl(input: { state: string }): string {
  const config = readLinearOAuthConfig();
  const url = new URL(LINEAR_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  // Full workspace control minus admin: write covers projects, documents,
  // initiatives, and agent delegation on top of the explicit create scopes.
  url.searchParams.set("scope", LINEAR_OAUTH_SCOPES);
  url.searchParams.set("actor", "user");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);

  return url.toString();
}

function parseTokenResponse(payload: z.infer<typeof linearOAuthTokenResponseSchema>): LinearTokenSet {
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : LINEAR_DEFAULT_TOKEN_EXPIRES_SECONDS;

  return {
    accessToken: readNonEmptyString(payload.access_token) ?? "",
    refreshToken: readNonEmptyString(payload.refresh_token) ?? "",
    tokenType: readNonEmptyString(payload.token_type) ?? OAUTH_TOKEN_TYPE_BEARER,
    scope: normalizeTokenScope({ scope: payload.scope }),
    expiresAt: new Date(Date.now() + expiresIn * MILLISECONDS_PER_SECOND).toISOString(),
  };
}

async function fetchLinearOAuthTokenPayload(input: {
  body: URLSearchParams;
  failurePrefix: string;
}): Promise<z.infer<typeof linearOAuthTokenResponseSchema>> {
  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: input.body,
  });
  const json: unknown = await response.json();
  const parsed = linearOAuthTokenResponseSchema.safeParse(json);
  const payload = parsed.success ? parsed.data : {};
  if (!response.ok) {
    throw new Error(
      formatLinearTokenOperationFailedMessage({ prefix: input.failurePrefix, detail: JSON.stringify(payload) }),
    );
  }

  return parsed.success ? parsed.data : {};
}

async function exchangeLinearCodeNamed(input: { code: string }): Promise<LinearTokenSet> {
  const config = readLinearOAuthConfig();
  const body = new URLSearchParams({
    code: input.code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "authorization_code",
  });
  const payload = await fetchLinearOAuthTokenPayload({
    body,
    failurePrefix: MESSAGE_LINEAR_TOKEN_EXCHANGE_FAILED_PREFIX,
  });

  return parseTokenResponse(payload);
}

export async function exchangeLinearCode(...args: [code: string]): Promise<LinearTokenSet> {
  return exchangeLinearCodeNamed({ code: args[0] });
}

async function refreshLinearTokenNamed(input: { tokens: LinearTokenSet }): Promise<LinearTokenSet> {
  const config = readLinearOAuthConfig();
  const body = new URLSearchParams({
    refresh_token: input.tokens.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  });
  const payload = await fetchLinearOAuthTokenPayload({
    body,
    failurePrefix: MESSAGE_LINEAR_TOKEN_REFRESH_FAILED_PREFIX,
  });

  return parseTokenResponse(payload);
}

export async function refreshLinearToken(...args: [tokens: LinearTokenSet]): Promise<LinearTokenSet> {
  return refreshLinearTokenNamed({ tokens: args[0] });
}

function collectLinearGraphqlErrorMessage(errors: { message?: string }[] | undefined): string | null {
  if (errors === undefined) {
    return null;
  }
  const parts = errors
    .map((error) => error.message)
    .filter((message): message is string => message !== undefined && message !== "");
  if (parts.length === 0) {
    return null;
  }

  return parts.join(MESSAGE_LINEAR_GRAPHQL_ERROR_SEPARATOR);
}

async function linearGraphqlNamed<T>(input: {
  tokens: LinearTokenSet;
  query: string;
  variables: Record<string, unknown>;
  dataSchema: z.ZodType<T>;
}): Promise<T> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.tokens.accessToken}`,
    },
    body: JSON.stringify({ query: input.query, variables: input.variables }),
  });
  const json: unknown = await response.json();
  const envelope = linearGraphqlEnvelopeSchema.safeParse(json);
  const payload = envelope.success ? envelope.data : {};
  const hasGraphqlErrors = (payload.errors?.length ?? 0) > 0;
  if (!response.ok || hasGraphqlErrors) {
    const message = collectLinearGraphqlErrorMessage(payload.errors);
    throw new Error(
      message !== null && message !== ""
        ? message
        : formatLinearGraphqlRequestFailedMessage({ status: response.status }),
    );
  }
  const dataParsed = input.dataSchema.safeParse(payload.data);
  if (!dataParsed.success) {
    throw new Error(formatLinearGraphqlRequestFailedMessage({ status: response.status }));
  }

  return dataParsed.data;
}

async function getLinearViewerNamed(input: { tokens: LinearTokenSet }) {
  return linearGraphqlNamed({
    tokens: input.tokens,
    query: "query Viewer { viewer { id name email } }",
    variables: {},
    dataSchema: linearViewerResponseSchema,
  });
}

export async function getLinearViewer(
  ...args: [tokens: LinearTokenSet]
): Promise<{ viewer: { id: string; name: string; email: string } }> {
  return getLinearViewerNamed({ tokens: args[0] });
}

async function getLinearTeamsNamed(input: { tokens: LinearTokenSet }) {
  return linearGraphqlNamed({
    tokens: input.tokens,
    query: `query Teams { teams(first: ${LINEAR_TEAMS_QUERY_FIRST}) { nodes { id name key } } }`,
    variables: {},
    dataSchema: linearTeamsResponseSchema,
  });
}

export async function getLinearTeams(
  ...args: [tokens: LinearTokenSet]
): Promise<{ teams: { nodes: { id: string; name: string; key: string }[] } }> {
  return getLinearTeamsNamed({ tokens: args[0] });
}

async function searchLinearIssuesNamed(input: { tokens: LinearTokenSet; term: string }) {
  return linearGraphqlNamed({
    tokens: input.tokens,
    query: `query SearchIssues($term: String!) {
      issues(first: ${LINEAR_SEARCH_ISSUES_FIRST}, filter: { or: [{ title: { containsIgnoreCase: $term } }, { description: { containsIgnoreCase: $term } }] }) {
        nodes { id identifier title url description state { name } }
      }
    }`,
    variables: { term: input.term },
    dataSchema: linearIssuesSearchResponseSchema,
  });
}

export async function searchLinearIssues(
  ...args: [tokens: LinearTokenSet, term: string]
): Promise<LinearIssuesSearchResponse> {
  return searchLinearIssuesNamed({ tokens: args[0], term: args[1] });
}

async function getLinearIssueNamed(input: { tokens: LinearTokenSet; issueId: string }) {
  return linearGraphqlNamed({
    tokens: input.tokens,
    query: `query Issue($id: String!) {
      issue(id: $id) { id identifier title url description state { name } }
    }`,
    variables: { id: input.issueId },
    dataSchema: linearIssueResponseSchema,
  });
}

export async function getLinearIssue(...args: [tokens: LinearTokenSet, issueId: string]): Promise<LinearIssueResponse> {
  return getLinearIssueNamed({ tokens: args[0], issueId: args[1] });
}

async function listLinearRecentIssuesNamed(input: { tokens: LinearTokenSet; limit: number }) {
  return linearGraphqlNamed({
    tokens: input.tokens,
    query: `query RecentIssues($first: Int!) {
      issues(first: $first, orderBy: updatedAt) {
        nodes { id identifier title url description state { name } }
      }
    }`,
    variables: { first: input.limit },
    dataSchema: linearIssuesListResponseSchema,
  });
}

export async function listLinearRecentIssues(
  ...args: [tokens: LinearTokenSet, limit?: number]
): Promise<LinearIssuesListResponse> {
  const limit = args[1] ?? DEFAULT_LINEAR_ISSUES_LIMIT;

  return listLinearRecentIssuesNamed({ tokens: args[0], limit });
}

async function listLinearViewerAssignedIssuesNamed(input: { tokens: LinearTokenSet; limit: number }) {
  return linearGraphqlNamed({
    tokens: input.tokens,
    query: `query ViewerAssignedIssues($first: Int!) {
      viewer {
        assignedIssues(first: $first, orderBy: updatedAt) {
          nodes { id identifier title url description state { name } }
        }
      }
    }`,
    variables: { first: input.limit },
    dataSchema: linearViewerAssignedIssuesResponseSchema,
  });
}

export async function listLinearViewerAssignedIssues(
  ...args: [tokens: LinearTokenSet, limit?: number]
): Promise<LinearViewerAssignedIssuesResponse> {
  const limit = args[1] ?? DEFAULT_LINEAR_ISSUES_LIMIT;

  return listLinearViewerAssignedIssuesNamed({ tokens: args[0], limit });
}

async function listLinearViewerCreatedIssuesNamed(input: { tokens: LinearTokenSet; limit: number }) {
  const viewer = await getLinearViewerNamed({ tokens: input.tokens });

  return linearGraphqlNamed({
    tokens: input.tokens,
    query: `query ViewerCreatedIssues($first: Int!, $viewerId: ID!) {
      issues(first: $first, orderBy: updatedAt, filter: { creator: { id: { eq: $viewerId } } }) {
        nodes { id identifier title url description assignee { id name } creator { id name } state { name } }
      }
    }`,
    variables: { first: input.limit, viewerId: viewer.viewer.id },
    dataSchema: linearViewerCreatedIssuesResponseSchema,
  });
}

export async function listLinearViewerCreatedIssues(
  ...args: [tokens: LinearTokenSet, limit?: number]
): Promise<LinearViewerCreatedIssuesResponse> {
  const limit = args[1] ?? DEFAULT_LINEAR_ISSUES_LIMIT;

  return listLinearViewerCreatedIssuesNamed({ tokens: args[0], limit });
}

async function sampleLinearIssuesNamed(input: { tokens: LinearTokenSet; teamId: string }) {
  return linearGraphqlNamed({
    tokens: input.tokens,
    query: `query TeamIssues($teamId: String!) {
      team(id: $teamId) {
        issues(first: ${LINEAR_SAMPLE_TEAM_ISSUES_FIRST}, orderBy: updatedAt) {
          nodes { id identifier title description labels { nodes { name } } }
        }
      }
    }`,
    variables: { teamId: input.teamId },
    dataSchema: linearSampleIssuesResponseSchema,
  });
}

export async function sampleLinearIssues(
  ...args: [tokens: LinearTokenSet, teamId: string]
): Promise<LinearSampleIssuesResponse> {
  return sampleLinearIssuesNamed({ tokens: args[0], teamId: args[1] });
}

async function createLinearIssueNamed(input: {
  tokens: LinearTokenSet;
  issueInput: {
    teamId: string;
    title: string;
    description: string;
  };
}) {
  return linearGraphqlNamed({
    tokens: input.tokens,
    query: `mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier title url createdAt team { id } }
      }
    }`,
    variables: {
      input: {
        teamId: input.issueInput.teamId,
        title: input.issueInput.title,
        description: input.issueInput.description,
      },
    },
    dataSchema: linearIssueCreateResponseSchema,
  });
}

export async function createLinearIssue(
  ...args: [
    tokens: LinearTokenSet,
    input: {
      teamId: string;
      title: string;
      description: string;
    },
  ]
): Promise<LinearIssueCreateResponse> {
  return createLinearIssueNamed({ tokens: args[0], issueInput: args[1] });
}

async function updateLinearIssueNamed(input: {
  tokens: LinearTokenSet;
  issueId: string;
  issueInput: {
    title?: string;
    description?: string;
  };
}) {
  return linearGraphqlNamed({
    tokens: input.tokens,
    query: `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue { id identifier title url }
      }
    }`,
    variables: { id: input.issueId, input: input.issueInput },
    dataSchema: linearIssueUpdateResponseSchema,
  });
}

export async function updateLinearIssue(
  ...args: [
    tokens: LinearTokenSet,
    issueId: string,
    input: {
      title?: string;
      description?: string;
    },
  ]
): Promise<LinearIssueUpdateResponse> {
  return updateLinearIssueNamed({ tokens: args[0], issueId: args[1], issueInput: args[2] });
}

async function getLinearIssueRelationNamed(input: { tokens: LinearTokenSet; relationId: string }) {
  return linearGraphqlNamed({
    tokens: input.tokens,
    query: `query IssueRelation($id: String!) {
      issueRelation(id: $id) {
        id
        type
        issue { id }
        relatedIssue { id }
      }
    }`,
    variables: { id: input.relationId },
    dataSchema: linearIssueRelationResponseSchema,
  });
}

function linearIssueRelationMatchesNamed(input: {
  relationInput: {
    id: string;
    issueId: string;
    relatedIssueId: string;
    type: "duplicate" | "related" | "blocks";
  };
  relation: LinearIssueRelation;
}) {
  return (
    input.relation.id === input.relationInput.id &&
    input.relation.issue.id === input.relationInput.issueId &&
    input.relation.relatedIssue.id === input.relationInput.relatedIssueId &&
    input.relation.type === input.relationInput.type
  );
}

function reconciledLinearIssueRelation(input: {
  relationInput: {
    id: string;
    issueId: string;
    relatedIssueId: string;
    type: "duplicate" | "related" | "blocks";
  };
  relation: LinearIssueRelation;
}): LinearIssueRelationCreateResult {
  if (!linearIssueRelationMatchesNamed({ relationInput: input.relationInput, relation: input.relation })) {
    throw new Error(MESSAGE_LINEAR_ISSUE_RELATION_MISMATCH);
  }

  return {
    issueRelationCreate: {
      success: true,
      issueRelation: input.relation,
    },
  };
}

async function createLinearIssueRelationNamed(input: {
  tokens: LinearTokenSet;
  relationInput: {
    id: string;
    issueId: string;
    relatedIssueId: string;
    type: "duplicate" | "related" | "blocks";
  };
}) {
  const existing = await getLinearIssueRelationNamed({ tokens: input.tokens, relationId: input.relationInput.id });
  if (existing.issueRelation !== null) {
    return reconciledLinearIssueRelation({ relationInput: input.relationInput, relation: existing.issueRelation });
  }
  try {
    const created = await linearGraphqlNamed({
      tokens: input.tokens,
      query: `mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) {
          success
          issueRelation {
            id
            type
            issue { id }
            relatedIssue { id }
          }
        }
      }`,
      variables: { input: input.relationInput },
      dataSchema: linearIssueRelationCreateResponseSchema,
    });
    const relation = created.issueRelationCreate.issueRelation;

    return relation !== null
      ? reconciledLinearIssueRelation({ relationInput: input.relationInput, relation })
      : created;
  } catch (error) {
    const reconciled = await getLinearIssueRelationNamed({ tokens: input.tokens, relationId: input.relationInput.id });
    if (reconciled.issueRelation !== null) {
      return reconciledLinearIssueRelation({ relationInput: input.relationInput, relation: reconciled.issueRelation });
    }
    throw error;
  }
}

export async function createLinearIssueRelation(
  ...args: [
    tokens: LinearTokenSet,
    input: {
      id: string;
      issueId: string;
      relatedIssueId: string;
      type: "duplicate" | "related" | "blocks";
    },
  ]
): Promise<CreateLinearIssueRelationResponse> {
  return createLinearIssueRelationNamed({ tokens: args[0], relationInput: args[1] });
}

async function uploadLinearFileNamed(input: {
  tokens: LinearTokenSet;
  fileInput: {
    filename: string;
    contentType: string;
    content: Buffer;
  };
}) {
  const prepared = await linearGraphqlNamed({
    tokens: input.tokens,
    query: `mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
      fileUpload(contentType: $contentType, filename: $filename, size: $size) {
        success
        uploadFile {
          uploadUrl
          assetUrl
          headers { key value }
        }
      }
    }`,
    variables: {
      contentType: input.fileInput.contentType,
      filename: input.fileInput.filename,
      size: input.fileInput.content.length,
    },
    dataSchema: linearFileUploadResponseSchema,
  });
  const uploadPayload = prepared.fileUpload;
  const upload = uploadPayload?.uploadFile;
  const isUploadSuccessful = uploadPayload?.success === true;
  const uploadUrl = readNonEmptyString(upload?.uploadUrl);
  const assetUrl = readNonEmptyString(upload?.assetUrl);
  if (!isUploadSuccessful || !upload || uploadUrl === null || assetUrl === null) {
    throw new Error(MESSAGE_LINEAR_FILE_UPLOAD_NO_DESTINATION);
  }
  const headers = new Headers();
  headers.set("content-type", input.fileInput.contentType);
  // Linear's signed upload flow requires this alongside the returned headers.
  // Set the documented default first so a provider-supplied value can override it.
  headers.set("cache-control", `${UPLOAD_CACHE_CONTROL_PREFIX}${UPLOAD_CACHE_MAX_AGE_SECONDS}`);
  upload.headers.forEach((header) => {
    headers.set(header.key, header.value);
  });
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers,
    body: new Uint8Array(input.fileInput.content),
  });
  if (!response.ok) {
    const responseBody = await response.text();
    const providerCodePattern = new RegExp(`<Code>([^<]{1,${LINEAR_UPLOAD_ERROR_CODE_MAX_LENGTH}})<\\/Code>`, "i");
    const providerCodeMatch = providerCodePattern.exec(responseBody)?.[1]?.trim() ?? null;
    const providerCode = providerCodeMatch !== null && providerCodeMatch !== "" ? providerCodeMatch : null;
    throw new LinearFileUploadError(response.status, providerCode);
  }

  return { assetUrl };
}

export async function uploadLinearFile(
  ...args: [
    tokens: LinearTokenSet,
    input: {
      filename: string;
      contentType: string;
      content: Buffer;
    },
  ]
): Promise<{ assetUrl: string }> {
  return uploadLinearFileNamed({ tokens: args[0], fileInput: args[1] });
}
