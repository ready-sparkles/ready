import assert from "node:assert/strict";
import test from "node:test";

import {
  createLinearIssueRelation,
  LinearFileUploadError,
  type LinearTokenSet,
  uploadLinearFile,
} from "../../application/linear-client";

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_FORBIDDEN = 403;
const EXPECTED_UPLOAD_FETCH_CALL_COUNT = 2;
const EXPECTED_RECONCILE_FETCH_CALL_COUNT = 3;
const FIRST_MUTATION_CALL_INDEX = 1;
const SECOND_RESPONSE_CALL_INDEX = 2;

const EXPECTED_EXISTING_RELATION_QUERY_MESSAGE = "Expected the existing-relation query";
const LINEAR_RESPONSE_TIMED_OUT_MESSAGE = "Linear response timed out";
const EXPECTED_RELATION_MUTATION_AND_QUERY_MESSAGE = "Expected the relation mutation and reconciliation query";

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

function fetchRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

function readRequestInitBody(init: RequestInit): string {
  if (typeof init.body === "string") {
    return init.body;
  }
  if (init.body === undefined) {
    return "undefined";
  }
  if (init.body === null) {
    return "null";
  }

  return JSON.stringify(init.body);
}

function stringifyOptionalRequestBody(init?: RequestInit): string {
  if (init === undefined) {
    return "undefined";
  }

  return readRequestInitBody(init);
}

const tokens: LinearTokenSet = {
  accessToken: "linear-token",
  refreshToken: "refresh-token",
  expiresAt: "2026-08-06T12:00:00.000Z",
  scope: "read,write",
  tokenType: "Bearer",
};

void test("Linear image upload prepares the asset then PUTs its bytes", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const callLog: { calls: { url: string; init?: RequestInit }[] } = { calls: [] };
  globalThis.fetch = async (input, init) => {
    const url = fetchRequestUrl(input);
    callLog.calls = [...callLog.calls, { url, init }];
    if (url === LINEAR_GRAPHQL_ENDPOINT) {
      return new Response(
        JSON.stringify({
          data: {
            fileUpload: {
              /** @external linear fileUpload success wire field */
              success: true,
              uploadFile: {
                uploadUrl: "https://uploads.linear.app/signed",
                assetUrl: "https://uploads.linear.app/asset/capture.jpg",
                headers: [{ key: "x-upload-token", value: "signed" }],
              },
            },
          },
        }),
        { status: HTTP_STATUS_OK, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(null, { status: HTTP_STATUS_OK });
  };

  const result = await uploadLinearFile(tokens, {
    filename: "capture.jpg",
    contentType: "image/jpeg",
    content: Buffer.from("image-bytes"),
  });
  assert.equal(result.assetUrl, "https://uploads.linear.app/asset/capture.jpg");
  assert.equal(callLog.calls.length, EXPECTED_UPLOAD_FETCH_CALL_COUNT);
  const firstCall = callLog.calls[0];
  assert.match(readRequestInitBody(firstCall?.init ?? {}), /fileUpload/);
  assert.match(readRequestInitBody(firstCall?.init ?? {}), /uploadFile/);
  assert.equal(callLog.calls[1]?.init?.method, "PUT");
  assert.equal(new Headers(callLog.calls[1].init.headers).get("x-upload-token"), "signed");
  assert.equal(new Headers(callLog.calls[1].init.headers).get("cache-control"), "public, max-age=31536000");
});

void test("Linear image upload preserves a safe provider failure code", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  globalThis.fetch = async (input) => {
    if (fetchRequestUrl(input) === LINEAR_GRAPHQL_ENDPOINT) {
      return new Response(
        JSON.stringify({
          data: {
            fileUpload: {
              /** @external linear fileUpload success wire field */
              success: true,
              uploadFile: {
                uploadUrl: "https://uploads.linear.app/signed",
                assetUrl: "https://uploads.linear.app/asset/capture.jpg",
                headers: [],
              },
            },
          },
        }),
        { status: HTTP_STATUS_OK, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(
      "<Error><Code>SignatureDoesNotMatch</Code><Message>Do not persist this body.</Message></Error>",
      { status: HTTP_STATUS_FORBIDDEN },
    );
  };

  await assert.rejects(
    uploadLinearFile(tokens, {
      filename: "capture.jpg",
      contentType: "image/jpeg",
      content: Buffer.from("image-bytes"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof LinearFileUploadError);
      assert.equal(error.code, "linear_file_upload_failed");
      assert.equal(error.message, "Linear file upload failed (403: SignatureDoesNotMatch)");
      assert.doesNotMatch(error.message, /Do not persist/);

      return true;
    },
  );
});

const relationInput = {
  id: "11111111-1111-4111-8111-111111111111",
  issueId: "issue-created",
  relatedIssueId: "issue-canonical",
  type: "duplicate" as const,
};

const matchingRelation = {
  id: relationInput.id,
  type: relationInput.type,
  issue: { id: relationInput.issueId },
  relatedIssue: { id: relationInput.relatedIssueId },
};

void test("Linear relation creation reuses an existing relation with the deterministic ID", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const callLog: { calls: string[] } = { calls: [] };
  globalThis.fetch = async (_input, init) => {
    callLog.calls = [...callLog.calls, stringifyOptionalRequestBody(init)];

    return new Response(JSON.stringify({ data: { issueRelation: matchingRelation } }), {
      status: HTTP_STATUS_OK,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await createLinearIssueRelation(tokens, relationInput);
  assert.equal(result.issueRelationCreate.success, true);
  assert.equal(result.issueRelationCreate.issueRelation?.id, relationInput.id);
  assert.equal(callLog.calls.length, 1);
  const existingRelationQuery = callLog.calls[0];
  if (existingRelationQuery === undefined) {
    throw new Error(EXPECTED_EXISTING_RELATION_QUERY_MESSAGE);
  }
  assert.match(existingRelationQuery, /query IssueRelation/);
  assert.doesNotMatch(existingRelationQuery, /mutation IssueRelationCreate/);
});

void test("Linear relation creation reconciles after a lost mutation response", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const callLog: { calls: string[] } = { calls: [] };
  globalThis.fetch = async (_input, init) => {
    const body = stringifyOptionalRequestBody(init);
    callLog.calls = [...callLog.calls, body];
    if (callLog.calls.length === 1) {
      return new Response(JSON.stringify({ data: { issueRelation: null } }), {
        status: HTTP_STATUS_OK,
        headers: { "content-type": "application/json" },
      });
    }
    if (callLog.calls.length === SECOND_RESPONSE_CALL_INDEX) {
      throw new TypeError(LINEAR_RESPONSE_TIMED_OUT_MESSAGE);
    }

    return new Response(JSON.stringify({ data: { issueRelation: matchingRelation } }), {
      status: HTTP_STATUS_OK,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await createLinearIssueRelation(tokens, relationInput);
  assert.equal(result.issueRelationCreate.issueRelation?.id, relationInput.id);
  assert.equal(callLog.calls.length, EXPECTED_RECONCILE_FETCH_CALL_COUNT);
  const createRelationMutation = callLog.calls[FIRST_MUTATION_CALL_INDEX];
  const reconciledRelationQuery = callLog.calls[SECOND_RESPONSE_CALL_INDEX];
  if (createRelationMutation === undefined || reconciledRelationQuery === undefined) {
    throw new Error(EXPECTED_RELATION_MUTATION_AND_QUERY_MESSAGE);
  }
  assert.match(createRelationMutation, /mutation IssueRelationCreate/);
  assert.match(reconciledRelationQuery, /query IssueRelation/);
});

void test("Linear relation reconciliation rejects a reused ID with different endpoints", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          issueRelation: {
            ...matchingRelation,
            relatedIssue: { id: "different-canonical-issue" },
          },
        },
      }),
      { status: HTTP_STATUS_OK, headers: { "content-type": "application/json" } },
    );

  await assert.rejects(createLinearIssueRelation(tokens, relationInput), /relation ID belongs to a different relation/);
});
