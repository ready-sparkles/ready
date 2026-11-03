import assert from "node:assert/strict";
import test from "node:test";

import { parseResponseText } from "../../application/openai-response-text";

const IGNORED_TEXT = "ignored";
const FIRST_TEXT = " first ";
const SECOND_TEXT = " second ";

void test("top-level nonblank text wins without whitespace changes", () => {
  assert.equal(
    parseResponseText({
      output_text: "  hello\n",
      output: [{ type: "message", content: [{ type: "output_text", text: IGNORED_TEXT }] }],
    }),
    "  hello\n",
  );
});

void test("fallback joins valid text in order, ignores invalid entries, and trims only the result", () => {
  assert.equal(
    parseResponseText({
      output_text: " \n",
      output: [
        null,
        { type: "reasoning", content: [] },
        { type: "message", content: null },
        {
          type: "message",
          content: [
            null,
            { type: "output_text", text: FIRST_TEXT },
            { type: "output_text", text: 1 },
            { type: "refusal", text: IGNORED_TEXT },
          ],
        },
        { type: "message", content: [{ type: "output_text", text: SECOND_TEXT }] },
      ],
    }),
    "first \n second",
  );
});

void test("malformed or empty input gives empty text", () => {
  [undefined, null, [], {}, { output_text: 1 }, { output: "text" }, { output: [] }].forEach((input) => {
    assert.equal(parseResponseText(input), "");
  });
});
