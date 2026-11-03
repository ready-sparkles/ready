import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AmbientContextPrivateDetails } from "@readymeet/shared";
import { act, renderHook } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import { ambientContextPillPresentation } from "../../../domain/ambient-context-view";
import { createAmbientContextItem } from "../../../domain/testing/ambient-context-fixture";
import { useAmbientPrivateDetails } from "../../../presentation/hooks/use-ambient-private-details";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const person = createAmbientContextItem({ entityKind: "person", status: "researching" });
const memory = {
  personId: person.id,
  name: person.displayName,
  summary: ["Known colleague."],
  standing: [],
  lastContact: null,
};
const ashby = { candidateName: person.displayName, profileUrl: "https://app.ashbyhq.com/candidate", facts: ["Active"] };
const PRIVATE_DETAILS_LOADER_ERROR = "Private details loader did not start";
const UNAVAILABLE_ERROR = "Unavailable";
const WEB_RESULT_SUMMARY = "Web result.";
const MISSING_SHARED_ITEM_ERROR = "Missing shared ambient item";
const SINGLE_LOAD_COUNT = 1;
const MENTION_COUNT_UPDATE = 2;
const ZERO_LOAD_COUNT = 0;
[
  { memory, ashby: null },
  { memory: null, ashby },
].forEach((details) => {
  void test(`web failure keeps loading until ${details.memory ? "memory" : "Ashby"} returns, then retains the card`, async () => {
    const pending: { resolve: ((value: AmbientContextPrivateDetails) => void) | null; count: number } = {
      resolve: null,
      count: 0,
    };
    const load = () => {
      pending.count += 1;

      return new Promise<AmbientContextPrivateDetails>((resolve) => {
        pending.resolve = resolve;
      });
    };
    const view = renderHook(({ items }) => useAmbientPrivateDetails({ items, load }), {
      initialProps: { items: [person] },
    });
    await act(async () => {});
    view.rerender({ items: [{ ...person, status: "failed" }] });
    assert.equal(ambientContextPillPresentation(view.result.current)?.phase, "loading");
    await act(async () => {
      const resolve = pending.resolve;
      if (resolve === null) {
        throw new Error(PRIVATE_DETAILS_LOADER_ERROR);
      }
      resolve(details);
    });
    assert.equal(ambientContextPillPresentation(view.result.current)?.phase, "result");
    view.rerender({ items: [{ ...person, status: "failed", mentionCount: MENTION_COUNT_UPDATE }] });
    assert.equal(pending.count, SINGLE_LOAD_COUNT);
    assert.equal(ambientContextPillPresentation(view.result.current)?.phase, "result");
    view.unmount();
  });
});

void test("empty or failed private lookup settles the loader without hiding successful web results", async () => {
  await [
    async () => null,
    async () => {
      throw new Error(UNAVAILABLE_ERROR);
    },
  ].reduce<Promise<void>>(async (previous, load) => {
    await previous;
    const view = renderHook(({ items }) => useAmbientPrivateDetails({ items, load }), {
      initialProps: { items: [{ ...person, status: "failed" as const }] as (typeof person)[] },
    });
    await act(async () => {});
    assert.equal(ambientContextPillPresentation(view.result.current), null);
    view.rerender({ items: [{ ...person, status: "ready", summary: WEB_RESULT_SUMMARY }] });
    assert.equal(ambientContextPillPresentation(view.result.current)?.phase, "result");
    view.unmount();
  }, Promise.resolve());
});

void test("viewer change discards private results and ignores the previous pending request; guests and companies never load", async () => {
  const pending: { resolve: ((value: AmbientContextPrivateDetails) => void) | null } = { resolve: null };
  const oldLoad: NonNullable<Parameters<typeof useAmbientPrivateDetails>[0]["load"]> = () =>
    new Promise<AmbientContextPrivateDetails>((resolve) => {
      pending.resolve = resolve;
    });
  const initialProps: { load: Parameters<typeof useAmbientPrivateDetails>[0]["load"] } = { load: oldLoad };
  const view = renderHook(({ load }) => useAmbientPrivateDetails({ items: [person], load }), { initialProps });
  await act(async () => {});
  view.rerender({ load: async () => null });
  await act(async () => {});
  await act(async () => {
    const resolve = pending.resolve;
    if (resolve === null) {
      throw new Error(PRIVATE_DETAILS_LOADER_ERROR);
    }
    resolve({ memory, ashby });
  });
  assert.equal(view.result.current[0]?.privateDetails, null);
  view.rerender({ load: undefined });
  assert.equal(view.result.current[0].privateDetails, undefined);
  view.unmount();
  const calls = { count: 0 };
  const companyView = renderHook(() =>
    useAmbientPrivateDetails({
      items: [{ ...person, entityKind: "company" }],
      load: async () => {
        calls.count += 1;

        return null;
      },
    }),
  );
  await act(async () => {});
  assert.equal(calls.count, ZERO_LOAD_COUNT);
  companyView.unmount();
});

[
  { memory, ashby: null },
  { memory: null, ashby },
].forEach((details) => {
  void test(`the same failed web lookup shows a card only to the participant with ${details.memory ? "memory" : "Ashby"} results`, async () => {
    const sharedItems = [{ ...person, status: "failed" as const }];
    const connectedLoad = async () => details;
    const emptyLoad = async () => ({ memory: null, ashby: null });
    const connected = renderHook(() => useAmbientPrivateDetails({ items: sharedItems, load: connectedLoad }));
    const otherParticipant = renderHook(() => useAmbientPrivateDetails({ items: sharedItems, load: emptyLoad }));
    const guest = renderHook(() => useAmbientPrivateDetails({ items: sharedItems, load: undefined }));
    await act(async () => {});
    assert.equal(ambientContextPillPresentation(connected.result.current)?.phase, "result");
    assert.equal(ambientContextPillPresentation(otherParticipant.result.current), null);
    assert.equal(ambientContextPillPresentation(guest.result.current), null);
    const sharedItem = sharedItems[0];
    if (sharedItem === undefined) {
      throw new Error(MISSING_SHARED_ITEM_ERROR);
    }
    assert.equal("privateDetails" in sharedItem, false, "shared meeting records are never enriched with private data");
    connected.unmount();
    otherParticipant.unmount();
    guest.unmount();
  });
});
