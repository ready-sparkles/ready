import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import { MeetingTaskEvidenceMark } from "../../../presentation/components/meeting-task-evidence";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const meetingId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const assetByteSize = 10;
const httpOkStatus = 200;

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

function restoreFetchAndBlobUrlMocks(options: {
  fetchImpl: typeof globalThis.fetch;
  createObjectUrl: typeof URL.createObjectURL;
  revokeObjectUrl: typeof URL.revokeObjectURL;
}): void {
  globalThis.fetch = options.fetchImpl;
  URL.createObjectURL = options.createObjectUrl;
  URL.revokeObjectURL = options.revokeObjectUrl;
}

const asset = {
  id: assetId,
  meetingId,
  kind: "screen_capture",
  mimeType: "image/jpeg",
  byteSize: assetByteSize,
  width: null,
  height: null,
  capturedAt: "2026-08-05T12:00:00.000Z",
  participantIdentity: "customer-browser",
  trackSid: "TR_screen",
  trigger: "automatic_bug_context",
  transcriptSegmentIds: ["33333333-3333-4333-8333-333333333333"],
  transcriptExcerpt: "When I click this button, the page is stuck here.",
  speakerName: "Customer",
  /** @external meeting asset fixture */
  includeInLinear: false,
  createdAt: "2026-08-05T12:00:00.000Z",
  updatedAt: "2026-08-05T12:00:00.000Z",
} as const;

void test("task evidence opens a private preview without a separate Linear approval", async () => {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
  const originalRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
  const requests: { values: { url: string; method: string }[] } = { values: [] };
  URL.createObjectURL = () => "blob:meeting-capture";
  URL.revokeObjectURL = () => undefined;
  globalThis.fetch = async (input, init) => {
    const url = fetchInputUrl(input);
    const method = init?.method ?? "GET";
    requests.values = [...requests.values, { url, method }];
    if (url.endsWith(`/assets/${assetId}/content`)) {
      return new Response(new Blob(["image"]), {
        status: httpOkStatus,
        headers: { "content-type": "image/jpeg" },
      });
    }

    return new Response(JSON.stringify({ assets: [asset] }), {
      status: httpOkStatus,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const view = render(<MeetingTaskEvidenceMark token="token" meetingId={meetingId} assetIds={[assetId]} />);
    fireEvent.click(view.getByRole("button", { name: "Preview screen capture" }));
    assert.notEqual(await view.findByRole("dialog", { name: "Screen capture" }), null);
    assert.notEqual(await view.findByText(/When I click this button/), null);
    assert.equal(view.queryByRole("button", { name: "Attach to Linear issue" }), null);
    assert.equal(
      requests.values.some((request) => request.method === "PATCH"),
      false,
    );
    view.unmount();
  } finally {
    restoreFetchAndBlobUrlMocks({
      fetchImpl: originalFetch,
      createObjectUrl: originalCreateObjectUrl,
      revokeObjectUrl: originalRevokeObjectUrl,
    });
  }
});
