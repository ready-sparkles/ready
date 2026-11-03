import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

// Anonymization placeholders such as "Personby" belong in test fixtures only.
// Demo copy, prompts, and other runtime strings must use real words.
const PLACEHOLDER_NAME = /\bPerson[a-z]{2}\b/g;
const ALLOWED_WORDS = new Set(["Personal"]);
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const RUNTIME_ROOTS = ["api", "assistant", "shared", "web"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "tests", "generated", ".next", "dist", "build", "public"]);
const SOURCE_FILE = /\.(ts|tsx|mts)$/;

function runtimeSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry) ? [] : runtimeSourceFiles(path);
    }

    return SOURCE_FILE.test(entry) && !entry.includes(".test.") ? [path] : [];
  });
}

void test("runtime TypeScript sources contain no anonymization placeholder names", () => {
  const offenders = RUNTIME_ROOTS.flatMap((root) => runtimeSourceFiles(join(REPO_ROOT, root))).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        Array.from(line.matchAll(PLACEHOLDER_NAME), (match) => match[0])
          .filter((word) => !ALLOWED_WORDS.has(word))
          .map((word) => `${relative(REPO_ROOT, path)}:${index + 1}: ${word}`),
      ),
  );

  assert.deepEqual(offenders, []);
});
