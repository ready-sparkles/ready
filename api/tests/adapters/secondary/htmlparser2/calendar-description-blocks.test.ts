import "../../../../composition/env";

import { buildReadyMeetCalendarDescriptionBlock } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { patchReadyMeetCalendarDescription } from "../../../../application/calendar-client";

const oldUrl = "https://www.ready.app/xyz-wxyz-xyz";
const input = { joinUrl: "https://ready.app/xyz-wxyz-xyz", callIn: { phoneNumber: "+12025550123", pin: "123456" } };
const plain = `Ready meeting\nJoin meeting: ${oldUrl}\nDial-in: (US) +1 202-555-0123 PIN: 987654#`;
const fixtures = [
  plain.replaceAll("\n", "<br>"),
  plain
    .split("\n")
    .map((line) => `<div>${line}</div>`)
    .join(""),
  plain
    .split("\n")
    .map((line) => `<p><b>${line}</b></p>`)
    .join(""),
  `<div>Ready&nbsp;meeting</div><div>Join meeting: <a href="${oldUrl}?a=1&amp;b=2">Click to join</a></div><div>Dial-in: (US) +1 202-555-0123 PIN: 987654#</div>`,
  `<div><span>Ready</span>&#32;meeting<br><span>Join meeting: </span><a href="${oldUrl}">${oldUrl}</a><br>Dial-in: (US) +1 202-555-0123 PIN: 987654#</div>`,
  `<p>Ready meeting</p><p><br></p><p>Join meeting: ${oldUrl}</p><p><br></p><p>Dial-in: (US) +1 202-555-0123 PIN: 987654#</p>`,
];

const FIXTURE_1_MISSING = "fixtures[1] is missing";

function fixture1(): string {
  const value = fixtures[1];
  if (value === undefined) {
    throw new Error(FIXTURE_1_MISSING);
  }

  return value;
}

const otherUrl = "https://ready.app/abc-defg-hij";
const otherPlain = `Ready meeting\nJoin meeting: ${otherUrl}\nDial-in: (US) +1 555-123-4567 PIN: 654321#`;
const otherBlocks = [
  otherPlain,
  `<div>Ready meeting</div><div>Join meeting: <a href="${otherUrl}">Other meeting</a></div><div>Dial-in: (US) +1 555-123-4567 PIN: 654321#</div>`,
  buildReadyMeetCalendarDescriptionBlock({ joinUrl: otherUrl, callIn: { phoneNumber: "+15551234567", pin: "654321" } }),
];
otherBlocks.forEach((other, index) => {
  void test(`preserves another meeting's block verbatim (format ${index + 1})`, () => {
    [other, `${other}\n\n${plain}`, `${plain}\n\n${other}\n\n${fixture1()}`].forEach((source) => {
      const patched = patchReadyMeetCalendarDescription(source, input);
      assert.ok(patched.includes(other), "The other meeting block must remain byte-for-byte unchanged");
      assert.equal((patched.match(/xyz-wxyz-xyz/g) ?? []).length, 1, "Only the target meeting is deduplicated");
      assert.equal(patchReadyMeetCalendarDescription(patched, input), patched);
    });
  });
});

void test("preserves bare meeting links in user notes, even for the target meeting", () => {
  const notes = `See ${input.joinUrl} and ${otherUrl} for background.`;
  const patched = patchReadyMeetCalendarDescription(`${notes}\n\n${plain}`, input);
  assert.ok(patched.startsWith(notes));
});

void test("recognizes the same meeting across case, public hostname, query, and trailing-slash variants", () => {
  const source = "Ready meeting\nJoin meeting: https://www.ready.app/XYZ-WXYZ-XYZ/?source=calendar";
  const patched = patchReadyMeetCalendarDescription(source, input);
  assert.equal((patched.match(/Ready meeting/g) ?? []).length, 1);
  assert.ok(patched.includes(input.joinUrl));
  assert.doesNotMatch(patched, /XYZ-WXYZ-XYZ/);
});

fixtures.forEach((block, index) => {
  void test(`HTML editor format ${index + 1} replaces Ready details and preserves the agenda`, () => {
    const before = "<p><b>Agenda &amp; notes</b></p>";
    const after = '<p>After: <a href="https://teams.microsoft.com/example">Teams</a></p>';
    const patched = patchReadyMeetCalendarDescription(before + block + after, input);
    assert.ok(patched.startsWith(before));
    assert.ok(patched.endsWith(after));
    assert.doesNotMatch(patched, /www\.ready\.app|987654/);
    assert.equal((patched.match(/xyz-wxyz-xyz/g) ?? []).length, 1);
    assert.equal(patchReadyMeetCalendarDescription(patched, input), patched);
    // Simulate another save by Google's editor, including auto-linking the URL.
    const resaved = patched
      .replaceAll("\n", "<br>")
      .replace(input.joinUrl, `<a href="${input.joinUrl}">${input.joinUrl}</a>`);
    assert.equal((patchReadyMeetCalendarDescription(resaved, input).match(/xyz-wxyz-xyz/g) ?? []).length, 1);
  });
});

void test("repairs duplicate text and HTML blocks while retaining intervening notes", () => {
  const patched = patchReadyMeetCalendarDescription(`${plain}\n\n<p>Keep this note</p>${fixture1()}`, input);
  assert.equal((patched.match(/Ready meeting/g) ?? []).length, 1);
  assert.equal((patched.match(/xyz-wxyz-xyz/g) ?? []).length, 1);
  assert.ok(patched.includes("<p>Keep this note</p>"));
  assert.doesNotMatch(patched, /www\.ready\.app|987654/);
});

void test("migrates legacy markers alongside HTML blocks without retaining duplicates", () => {
  const legacy = buildReadyMeetCalendarDescriptionBlock({ joinUrl: oldUrl });
  const patched = patchReadyMeetCalendarDescription(`${legacy}<p>Keep this note</p>${fixture1()}`, input);
  assert.equal((patched.match(/Ready meeting/g) ?? []).length, 1);
  assert.doesNotMatch(patched, /READY_MEET_BLOCK|www\.ready\.app/);
  assert.ok(patched.includes("<p>Keep this note</p>"));
});

void test("does not trust a Ready-looking label on an unrelated link", () => {
  const original = `<div>Ready meeting<br>Join meeting: <a href="https://evil.test/abc-defg-hij">${oldUrl}</a></div>`;
  assert.ok(patchReadyMeetCalendarDescription(original, input).startsWith(original));
});

void test("keeps partially shared formatting parents balanced and preserves user notes", () => {
  const original = `<b>Keep before\nReady meeting</b><div>Join meeting: ${oldUrl}\nKeep after</div>`;
  const patched = patchReadyMeetCalendarDescription(original, input);
  assert.ok(patched.startsWith("<b>Keep before\nReady meeting"));
  assert.ok(patched.endsWith("</b><div>\nKeep after</div>"));
  assert.doesNotMatch(patched, /www\.ready\.app/);
  assert.equal(patchReadyMeetCalendarDescription(patched, input), patched);
});
