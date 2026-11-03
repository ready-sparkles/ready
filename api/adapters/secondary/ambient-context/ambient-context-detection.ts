import { createHash } from "node:crypto";

const MENTION_CONTEXT_TOKEN_RADIUS = 7;
const HASH_HEX_PREFIX_LENGTH = 16;
const AMBIENT_CANONICAL_KEY_MAX_LENGTH = 320;
const AMBIENT_CANONICAL_KEY_TRUNCATE_LENGTH = 303;
const MIN_PERSON_DISPLAY_NAME_WORDS = 2;
const MIN_AMBIENT_MENTION_COUNT_FOR_INCIDENTAL = 2;

const GENERIC_COMPANY_WORDS = new Set([
  "company",
  "competitor",
  "customer",
  "client",
  "vendor",
  "partner",
  "startup",
  "business",
  "bank",
  "agency",
  "team",
  "organization",
  "platform",
  "provider",
]);

const AMBIGUOUS_SINGLE_WORD_COMPANIES = new Set([
  // Common Finnish question/function words that speech-to-text may capitalize.
  "kuka",
  "mika",
  "mita",
  "missä",
  "missa",
  "milloin",
  "miten",
  "miksi",
  "joka",
  "kun",
  "on",
  // Equivalent English words are useful protection in mixed-language calls.
  "who",
  "what",
  "where",
  "when",
  "how",
  "why",
  "which",
  "that",
  "this",
]);

const AMBIGUOUS_NON_ENTITY_PHRASES = new Set([
  "kuka on",
  "mika on",
  "mita on",
  "who is",
  "what is",
  "where is",
  "how is",
]);

const COMPANY_CONTEXT_CUES = new Set([
  "company",
  "startup",
  "business",
  "vendor",
  "client",
  "customer",
  "partner",
  "platform",
  "product",
  "app",
  "website",
  "software",
  "service",
  "team",
  "employer",
  "works",
  "joined",
  "founded",
  "founder",
  "ceo",
  "funding",
  "raised",
  "acquired",
  "revenue",
  "pricing",
  "robots",
  "robotics",
  "automation",
  "use",
  "uses",
  "using",
  "yritys",
  "yhtio",
  "startup",
  "asiakas",
  "toimittaja",
  "kumppani",
  "alusta",
  "tuote",
  "palvelu",
  "ohjelmisto",
  "verkkosivu",
  "toissa",
  "perusti",
  "perustaja",
  "toimitusjohtaja",
  "rahoitus",
  "liikevaihto",
  "hinnoittelu",
  "robotit",
  "robotiikka",
  "automaatio",
  "kayttaa",
  "kaytamme",
]);

const COMPANY_LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "company",
  "co",
  "oy",
  "oyj",
  "ab",
  "gmbh",
  "plc",
  "sa",
  "ag",
]);

export function normalizeTranscriptText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function localMentionWindows(input: { displayName: string; content: string[] }) {
  const nameTokens = normalizeTranscriptText(input.displayName).split(" ").filter(Boolean);
  if (nameTokens.length === 0) {
    return [];
  }

  return input.content.flatMap((text) => {
    const tokens = normalizeTranscriptText(text).split(" ").filter(Boolean);
    const windowCount = tokens.length - nameTokens.length + 1;

    return Array.from({ length: Math.max(0, windowCount) }, (_, index) => index)
      .filter((index) => nameTokens.every((token, offset) => tokens[index + offset] === token))
      .map((index) =>
        tokens.slice(
          Math.max(0, index - MENTION_CONTEXT_TOKEN_RADIUS),
          Math.min(tokens.length, index + nameTokens.length + MENTION_CONTEXT_TOKEN_RADIUS),
        ),
      );
  });
}

export function hasCompanyContextEvidence(...args: [displayName: string, content: string[]]): boolean {
  const [displayName, content] = args;
  const nameTokens = normalizeTranscriptText(displayName).split(" ").filter(Boolean);
  if (nameTokens.some((token) => COMPANY_LEGAL_SUFFIXES.has(token))) {
    return true;
  }

  return localMentionWindows({ displayName, content }).some((tokens) =>
    tokens.some((token) => COMPANY_CONTEXT_CUES.has(token)),
  );
}

function normalizedIdentityKeyPart(input: { value: string }) {
  const normalized = input.value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length > 0) {
    return normalized;
  }

  return `u-${createHash("sha256").update(input.value.normalize("NFKC")).digest("hex").slice(0, HASH_HEX_PREFIX_LENGTH)}`;
}

export function ambientContextCanonicalKey(input: {
  kind: "person" | "company";
  displayName: string;
  qualifier: string | null;
}): string {
  const rawName = normalizedIdentityKeyPart({ value: input.displayName });
  const normalizedName =
    input.kind === "company"
      ? rawName.replace(/\s+(?:incorporated|inc|corporation|corp|limited|ltd|llc|company|co)$/i, "").trim()
      : rawName;
  const normalizedQualifier =
    input.qualifier !== null && input.qualifier !== "" ? normalizedIdentityKeyPart({ value: input.qualifier }) : "";
  const identity = `${input.kind}:${normalizedName}${normalizedQualifier.length > 0 ? `@${normalizedQualifier}` : ""}`;
  if (identity.length <= AMBIENT_CANONICAL_KEY_MAX_LENGTH) {
    return identity;
  }
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, HASH_HEX_PREFIX_LENGTH);

  return `${identity.slice(0, AMBIENT_CANONICAL_KEY_TRUNCATE_LENGTH)}:${hash}`;
}

export type AmbientDetection = {
  kind: "person" | "company";
  displayName: string;
  qualifier: string | null;
  facets: string[];
  segmentIds: string[];
  // Evidence cardinality for the shared persistence path, not model confidence.
  mentionCount: number;
  canonicalKey?: string;
  /** @external ambient detection reference-only wire field */
  referenceOnly?: boolean;
  legacyPolicy?: { confidence: "high" | "medium" | "low"; intent: "explicit" | "contextual" | "incidental" };
};

export function containsTranscriptName(...args: [text: string, value: string]): boolean {
  const [text, value] = args;
  const needle = normalizeTranscriptText(value);

  return needle.length > 0 && ` ${normalizeTranscriptText(text)} `.includes(` ${needle} `);
}

// Grounding differs by detector (literal names vs resolved references), but
// grammatical words and generic categories are never valid entity identities.
export function passesAmbientLexicalGuards(
  ...args: [input: Pick<AmbientDetection, "kind" | "displayName">, content: string[]]
): boolean {
  const [input, content] = args;
  const name = normalizeTranscriptText(input.displayName);
  if (
    name.length === 0 ||
    ["ready", "readymeet", "ready meet"].includes(name) ||
    AMBIGUOUS_NON_ENTITY_PHRASES.has(name)
  ) {
    return false;
  }
  if (input.kind === "person") {
    return input.displayName.trim().split(/\s+/u).length >= MIN_PERSON_DISPLAY_NAME_WORDS;
  }

  return (
    !GENERIC_COMPANY_WORDS.has(name) &&
    (!AMBIGUOUS_SINGLE_WORD_COMPANIES.has(name) || hasCompanyContextEvidence(input.displayName, content))
  );
}

export function passesAmbientDetectionGuards(
  ...args: [input: AmbientDetection, matchingContent: string[], surroundingContent: string[]]
): boolean {
  const [input, matchingContent, surroundingContent] = args;
  if (!passesAmbientLexicalGuards(input, surroundingContent)) {
    return false;
  }
  const policy = input.legacyPolicy;
  if (!policy) {
    return true;
  } // Segment detector already grounds explicit names and references.
  if (!matchingContent.some((content) => containsTranscriptName(content, input.displayName))) {
    return false;
  }
  if (
    policy.confidence === "low" ||
    (policy.intent === "incidental" && input.mentionCount < MIN_AMBIENT_MENTION_COUNT_FOR_INCIDENTAL)
  ) {
    return false;
  }

  return !(
    input.kind === "company" &&
    !normalizeTranscriptText(input.displayName).includes(" ") &&
    policy.confidence === "medium" &&
    policy.intent !== "explicit" &&
    input.mentionCount < MIN_AMBIENT_MENTION_COUNT_FOR_INCIDENTAL &&
    !hasCompanyContextEvidence(input.displayName, surroundingContent)
  );
}
