const PLACEHOLDER_TITLE_PATTERN = /^(instant meeting|untitled meeting)$/i;
const LOW_SIGNAL_WORDS = new Set([
  "ah",
  "audio",
  "check",
  "checking",
  "eh",
  "hello",
  "hear",
  "here",
  "hey",
  "hi",
  "hmm",
  "mic",
  "microphone",
  "mm",
  "mmm",
  "no",
  "okay",
  "okei",
  "test",
  "testing",
  "tota",
  "tuota",
  "um",
  "uh",
  "yeah",
  "joo",
  "juu",
  "kylla",
  "kyllä",
  "niin",
  "niinku",
  "siis",
]);

const EAGER_TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "about",
  "can",
  "could",
  "doing",
  "for",
  "from",
  "give",
  "hey",
  "how",
  "i",
  "in",
  "is",
  "it",
  "lets",
  "let",
  "like",
  "me",
  "need",
  "of",
  "on",
  "please",
  "the",
  "to",
  "today",
  "us",
  "we",
  "what",
  "whats",
  "with",
  "would",
  "you",
]);

const IMPERATIVE_TITLE_OPENERS = new Set([
  "analyze",
  "compare",
  "create",
  "find",
  "get",
  "give",
  "help",
  "identify",
  "list",
  "look",
  "make",
  "research",
  "search",
  "show",
  "summarize",
  "tell",
]);

const STRONGLY_IMPERATIVE_TITLE_OPENERS = new Set([
  "create",
  "find",
  "get",
  "give",
  "help",
  "identify",
  "list",
  "look",
  "make",
  "search",
  "show",
  "summarize",
  "tell",
]);

const REQUEST_TITLE_MARKERS = new Set([
  "different",
  "examples",
  "ideas",
  "options",
  "relevant",
  "things",
  "various",
  "ways",
]);

const TRANSCRIPT_FRAGMENT_TITLE_OPENERS = new Set([
  "se",
  "siella",
  "siellä",
  "taa",
  "tää",
  "tama",
  "tämä",
  "tuo",
  "joo",
  "juu",
  "kylla",
  "kyllä",
]);

const TRANSCRIPT_FRAGMENT_TITLE_MARKERS = new Set([
  "bugi",
  "bugeja",
  "katotaan",
  "kokeillaan",
  "testi",
  "toimis",
  "toimisi",
  "toimii",
  "eka",
  "ensimmainen",
  "ensimmäinen",
]);

type ParticipantTitleInput = {
  userId?: string | null;
  displayName?: string | null;
  email?: string | null;
  role?: string | null;
  joinedAt?: Date | string | null;
};

const HUMAN_PARTICIPANT_ROLES = new Set(["host", "guest"]);
const PARTICIPANT_SORT_RANK_HOST = 0;
const PARTICIPANT_SORT_RANK_GUEST = 1;
const PARTICIPANT_SORT_RANK_DEFAULT = 2;
const MIN_COMPACT_PARTICIPANT_NAME_LENGTH = 2;
const MIN_REPEATED_LOW_SIGNAL_WORD_COUNT = 3;
const DOMINANT_LOW_SIGNAL_WORD_RATIO = 0.6;
const LOW_SIGNAL_WORDS_IN_TITLE_RATIO = 0.5;
const MIN_SCRIPT_DOMINANCE_RATIO = 0.5;
const MIN_FILTERED_TITLE_WORDS = 2;
const MAX_EAGER_TITLE_WORDS = 6;
const MIN_MEANINGFUL_TITLE_WORD_COUNT = 2;
const IMPERATIVE_REQUEST_MIN_WORD_COUNT = 3;

export function normalizeTranscriptTitleContent(content: string): string {
  return content
    .replace(/\s+/g, " ")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
}

function normalizeTitleForQuality(title: string) {
  return normalizeTranscriptTitleContent(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function titleWords(title: string) {
  return normalizeTitleForQuality(title).split(" ").filter(Boolean);
}

function participantIdentityKey(participant: ParticipantTitleInput): string | null {
  const userId = participant.userId?.trim();
  if (userId !== undefined && userId.length > 0) {
    return userId;
  }
  const email = participant.email?.trim().toLowerCase();
  if (email !== undefined && email.length > 0) {
    return email;
  }
  const displayName = participant.displayName?.trim().toLowerCase();
  if (displayName !== undefined && displayName.length > 0) {
    return displayName;
  }

  return null;
}

function participantSortRank(participant: ParticipantTitleInput): number {
  if (participant.role === "host") {
    return PARTICIPANT_SORT_RANK_HOST;
  }
  if (participant.role === "guest") {
    return PARTICIPANT_SORT_RANK_GUEST;
  }

  return PARTICIPANT_SORT_RANK_DEFAULT;
}

function joinedAtTime(participant: ParticipantTitleInput) {
  if (participant.joinedAt instanceof Date) {
    return participant.joinedAt.getTime();
  }
  if (typeof participant.joinedAt === "string") {
    const parsed = Date.parse(participant.joinedAt);

    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  }

  return Number.MAX_SAFE_INTEGER;
}

function normalizeParticipantName(input: string | null | undefined): string | null {
  const normalized = input
    ?.replace(/\s+/g, " ")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();

  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function participantEmailName(email: string | null | undefined): string | null {
  const normalized = normalizeParticipantName(email);
  if (normalized === null || !normalized.includes("@")) {
    return null;
  }

  const localPart = normalized.split("@")[0]?.trim();
  if (localPart === undefined || localPart.length === 0 || /^guest[+._-]/i.test(localPart)) {
    return null;
  }

  return normalizeParticipantName(localPart.replace(/[._-]+/g, " "));
}

function capitalizeAllLowercaseName(name: string) {
  // Only repair names typed fully in lowercase ("personbs"); any existing
  // uppercase means deliberate casing to preserve.
  if (/\p{Lu}/u.test(name)) {
    return name;
  }

  return toTitleCase(name);
}

function compactParticipantName(name: string): string | null {
  const cleaned = normalizeParticipantName(name);
  if (cleaned === null) {
    return null;
  }

  const [firstWord] = cleaned.split(/\s+/);

  return firstWord !== undefined && firstWord.length >= MIN_COMPACT_PARTICIPANT_NAME_LENGTH ? firstWord : cleaned;
}

function hasRepeatedLowSignalShape(words: string[]): boolean {
  if (words.length < MIN_REPEATED_LOW_SIGNAL_WORD_COUNT) {
    return false;
  }

  const counts = words.reduce<Map<string, number>>((map, word) => {
    const next = new Map(map);

    return next.set(word, (map.get(word) ?? 0) + 1);
  }, new Map());

  const dominant = Array.from(counts.entries()).reduce(
    (best, [word, count]) => (count > best.highestCount ? { dominantWord: word, highestCount: count } : best),
    { dominantWord: "", highestCount: 0 },
  );

  const lowSignalCount = words.filter((word) => LOW_SIGNAL_WORDS.has(word)).length;

  return (
    (LOW_SIGNAL_WORDS.has(dominant.dominantWord) &&
      dominant.highestCount / words.length >= DOMINANT_LOW_SIGNAL_WORD_RATIO) ||
    lowSignalCount / words.length >= LOW_SIGNAL_WORDS_IN_TITLE_RATIO
  );
}

function hasTranscriptFragmentTitleShape(words: string[]): boolean {
  const [firstWord] = words;
  if (firstWord === undefined || firstWord.length === 0 || !TRANSCRIPT_FRAGMENT_TITLE_OPENERS.has(firstWord)) {
    return false;
  }

  return words.some((word) => TRANSCRIPT_FRAGMENT_TITLE_MARKERS.has(word));
}

function hasImperativeRequestTitleShape(words: string[]): boolean {
  const [firstWord, secondWord] = words;
  if (firstWord === undefined || firstWord.length === 0 || !IMPERATIVE_TITLE_OPENERS.has(firstWord)) {
    return false;
  }

  if (secondWord !== undefined && secondWord !== "" && IMPERATIVE_TITLE_OPENERS.has(secondWord)) {
    return true;
  }

  if (STRONGLY_IMPERATIVE_TITLE_OPENERS.has(firstWord)) {
    return true;
  }

  const hasRequestMarker = words.some((word) => REQUEST_TITLE_MARKERS.has(word) || /^\d+$/.test(word));

  return hasRequestMarker || words.length > IMPERATIVE_REQUEST_MIN_WORD_COUNT;
}

function buildResearchIntentTitle(normalized: string) {
  const hasFindOrResearchIntent = /\b(find|search|research|identify|list|look|show|relevant)\b/u.test(normalized);
  const hasCompareIntent = /\b(compare|comparison|different|versus|vs)\b/u.test(normalized);
  if (!hasFindOrResearchIntent && !hasCompareIntent) {
    return null;
  }

  const entityLabels: [RegExp, string][] = [
    [/\bcompetitors?\b/u, "Competitor"],
    [/\bvendors?\b/u, "Vendor"],
    [/\bstartups?\b/u, "Startup"],
    [/\btools?\b/u, "Tool"],
    [/\bproducts?\b/u, "Product"],
    [/\bproviders?\b/u, "Provider"],
    [/\bagencies\b/u, "Agency"],
    [/\bcompan(?:y|ies)\b/u, "Company"],
  ];

  const matchedEntity = entityLabels.find(([pattern]) => pattern.test(normalized));
  if (!matchedEntity) {
    return null;
  }

  const [, label] = matchedEntity;

  return `${label} ${hasCompareIntent ? "Comparison" : "Research"}`;
}

export function buildOneOnOneParticipantTitle(participants: ParticipantTitleInput[]): string | null {
  const seen = new Set<string>();
  const humanParticipants = participants
    .filter(
      (participant) =>
        participant.role === null || participant.role === undefined || HUMAN_PARTICIPANT_ROLES.has(participant.role),
    )
    .filter((participant) => {
      const key = participantIdentityKey(participant);
      if (key === null || seen.has(key)) {
        return false;
      }
      seen.add(key);

      return true;
    })
    .sort((left, right) => {
      const rankDifference = participantSortRank(left) - participantSortRank(right);

      return rankDifference !== 0 ? rankDifference : joinedAtTime(left) - joinedAtTime(right);
    });

  const ONE_ON_ONE_PARTICIPANT_COUNT = 2;
  if (humanParticipants.length !== ONE_ON_ONE_PARTICIPANT_COUNT) {
    return null;
  }

  const fullNames = humanParticipants.map((participant) => {
    const displayName = normalizeParticipantName(participant.displayName);
    const name = displayName ?? participantEmailName(participant.email);

    return name === null ? null : capitalizeAllLowercaseName(name);
  });
  if (fullNames.some((name) => name === null)) {
    return null;
  }

  const resolvedFullNames = fullNames.filter((name): name is string => name !== null);
  const compactNames = resolvedFullNames.map((name) => compactParticipantName(name));
  if (compactNames.some((name) => name === null)) {
    return null;
  }

  const resolvedCompactNames = compactNames.filter((name): name is string => name !== null);
  const normalizedCompactNames = resolvedCompactNames.map((name) => name.toLowerCase());
  const titleNames =
    new Set(normalizedCompactNames).size === resolvedCompactNames.length ? resolvedCompactNames : resolvedFullNames;
  const normalizedTitleNames = titleNames.map((name) => name.toLowerCase());
  if (new Set(normalizedTitleNames).size !== titleNames.length) {
    return null;
  }

  const [firstTitle, secondTitle] = titleNames;

  return firstTitle !== undefined && secondTitle !== undefined ? `${firstTitle} : ${secondTitle}` : null;
}

const TITLE_SCRIPT_PATTERNS = {
  latin: /\p{Script=Latin}/gu,
  cyrillic: /\p{Script=Cyrillic}/gu,
  greek: /\p{Script=Greek}/gu,
  arabic: /\p{Script=Arabic}/gu,
  hebrew: /\p{Script=Hebrew}/gu,
  cjk: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
} as const;

type TranscriptScript = keyof typeof TITLE_SCRIPT_PATTERNS;

function countScriptLetters(input: { text: string; script: TranscriptScript }): number {
  return input.text.match(TITLE_SCRIPT_PATTERNS[input.script])?.length ?? 0;
}

const TRANSCRIPT_SCRIPT_KEYS: TranscriptScript[] = ["latin", "cyrillic", "greek", "arabic", "hebrew", "cjk"];

export function dominantTranscriptScript(texts: string[]): TranscriptScript | null {
  const combined = texts.join(" ");
  const scriptCounts = TRANSCRIPT_SCRIPT_KEYS.map((script) => ({
    script,
    count: countScriptLetters({ text: combined, script }),
  }));
  const totalCount = scriptCounts.reduce((sum, entry) => sum + entry.count, 0);
  const dominant = scriptCounts.reduce((best, entry) => (entry.count > best.count ? entry : best), {
    script: null as TranscriptScript | null,
    count: 0,
  });

  if (dominant.script === null || totalCount === 0 || dominant.count / totalCount < MIN_SCRIPT_DOMINANCE_RATIO) {
    return null;
  }

  return dominant.script;
}

export function matchesTranscriptScript(input: { text: string; script: TranscriptScript }): boolean {
  const totalCount = TRANSCRIPT_SCRIPT_KEYS.reduce(
    (sum, candidate) => sum + countScriptLetters({ text: input.text, script: candidate }),
    0,
  );
  if (totalCount === 0) {
    return false;
  }

  return countScriptLetters({ text: input.text, script: input.script }) / totalCount >= MIN_SCRIPT_DOMINANCE_RATIO;
}

export function titlesMatchIgnoringCase(input: {
  left: string | null | undefined;
  right: string | null | undefined;
}): boolean {
  const { left, right } = input;
  if (
    left === null ||
    left === undefined ||
    left.length === 0 ||
    right === null ||
    right === undefined ||
    right.length === 0
  ) {
    return false;
  }

  // Case-insensitive only. Punctuation must match exactly: an edit like
  // "Avery Quinn" or "Avery/Quinn" is a manual rename, not the generated fallback.
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

  return normalize(left) === normalize(right);
}

export function isReplaceableGeneratedMeetingTitle(title: string): boolean {
  const normalized = normalizeTitleForQuality(title);
  if (normalized.length === 0 || PLACEHOLDER_TITLE_PATTERN.test(normalized)) {
    return true;
  }

  const words = titleWords(title);
  if (words.length === 0) {
    return true;
  }

  if (words.every((word) => LOW_SIGNAL_WORDS.has(word))) {
    return true;
  }

  if (/\b(can you hear|hear me|test test|audio check|mic check)\b/i.test(normalized)) {
    return true;
  }

  if (hasTranscriptFragmentTitleShape(words)) {
    return true;
  }

  if (/^(hello|hi|hey)\b/i.test(normalized) && hasRepeatedLowSignalShape(words)) {
    return true;
  }

  return hasRepeatedLowSignalShape(words) || hasImperativeRequestTitleShape(words);
}

export function shouldReplaceMeetingTitleWithSnapshot(title: string): boolean {
  return isReplaceableGeneratedMeetingTitle(title);
}

export function buildConservativeTranscriptTitle(content: string): string | null {
  const normalized = normalizeTitleForQuality(content);
  if (normalized.length === 0) {
    return null;
  }

  const researchIntentTitle = buildResearchIntentTitle(normalized);
  if (researchIntentTitle !== null) {
    return researchIntentTitle;
  }

  const weatherMatch = normalized.match(/\bweather(?: like)?(?: in)? ([\p{L}\s-]{2,40})$/u);
  const weatherLocation = weatherMatch?.[1];
  if (weatherLocation !== undefined && weatherLocation.length > 0) {
    return `Weather in ${toTitleCase(weatherLocation.trim())}`;
  }

  const filteredWords = normalized
    .split(" ")
    .filter((word) => word.length > 1)
    .filter((word) => !EAGER_TITLE_STOP_WORDS.has(word))
    .slice(0, MAX_EAGER_TITLE_WORDS);

  if (filteredWords.length < MIN_FILTERED_TITLE_WORDS) {
    return null;
  }

  const title = toTitleCase(filteredWords.join(" "));
  if (isReplaceableGeneratedMeetingTitle(title)) {
    return null;
  }

  const meaningfulWordCount = filteredWords.filter((word) => !LOW_SIGNAL_WORDS.has(word)).length;
  if (meaningfulWordCount < MIN_MEANINGFUL_TITLE_WORD_COUNT) {
    return null;
  }

  return title;
}
