import { GlobalRegistrator } from "@happy-dom/global-registrator";
import assert from "node:assert/strict";
import test from "node:test";

import { copyShowcaseStyles } from "../../domain/showcase-styles";

GlobalRegistrator.register();

function documents() {
  const source = document.implementation.createHTMLDocument();
  const target = document.implementation.createHTMLDocument();
  source.head.innerHTML = '<style>.avatar { width: 64px; }</style><link rel="stylesheet"><link rel="stylesheet">';
  target.head.innerHTML = "<style data-showcase-style>/* previous styles */</style>";

  return { source, target };
}

const EXPECTED_SHOWCASE_STYLES = "Expected showcase styles";
const EXPECTED_SHOWCASE_STYLE_ELEMENT_COUNT = 3;

function stylesheetLinks(target: Document) {
  const links = [...target.querySelectorAll("link")];
  const first = links[0];
  const second = links[1];
  if (first === undefined || second === undefined) {
    throw new Error(EXPECTED_SHOWCASE_STYLES);
  }

  return { first, second };
}

void test("waits for every stylesheet and retains the previous styles until ready", async () => {
  const { source, target } = documents();
  const previous = target.head.firstElementChild;
  if (previous === null) {
    throw new Error(EXPECTED_SHOWCASE_STYLES);
  }
  const ready = { isReady: false };
  const cleanup = copyShowcaseStyles({
    source,
    target,
    onReady: () => {
      ready.isReady = true;
    },
  });
  const links = stylesheetLinks(target);
  links.first.dispatchEvent(new Event("load"));
  await Promise.resolve();
  assert.equal(ready.isReady, false);
  assert.equal(previous.isConnected, true);
  links.second.dispatchEvent(new Event("load"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ready.isReady, true);
  assert.equal(previous.isConnected, false);
  cleanup();
  assert.equal(target.querySelectorAll("[data-showcase-style]").length, EXPECTED_SHOWCASE_STYLE_ELEMENT_COUNT);
});

void test("failed or cancelled copies never reveal unstyled content or discard working styles", async () => {
  await (["error", "cancel"] as const).reduce(async (previousOutcome, outcome) => {
    await previousOutcome;
    const { source, target } = documents();
    const previous = target.head.firstElementChild;
    if (previous === null) {
      throw new Error(EXPECTED_SHOWCASE_STYLES);
    }
    const ready = { isReady: false };
    const cleanup = copyShowcaseStyles({
      source,
      target,
      onReady: () => {
        ready.isReady = true;
      },
    });
    const links = stylesheetLinks(target);
    if (outcome === "cancel") {
      cleanup();
    }
    links.first.dispatchEvent(new Event(outcome === "error" ? "error" : "load"));
    links.second.dispatchEvent(new Event("load"));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(ready.isReady, false);
    assert.equal(previous.isConnected, true);
    assert.equal(target.querySelectorAll("[data-showcase-style]").length, 1);
    cleanup();
  }, Promise.resolve());
});
