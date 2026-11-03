import { z } from "zod";

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
const ACQUISITION_RETENTION_DAYS = 90;
export const ACQUISITION_MAX_AGE_SECONDS = ACQUISITION_RETENTION_DAYS * SECONDS_PER_DAY;
const LABEL_MAX_LENGTH = 100;
const CLICK_ID_MAX_LENGTH = 256;
const CLIENT_ID_MAX_LENGTH = 80;
const SESSION_ID_MAX_LENGTH = 24;
const CAMPAIGN_ID_MAX_DIGITS = 24;
const ACQUISITION_COOKIE_MAX_BYTES = 8_000;
const ACQUISITION_CLOCK_SKEW_MS = 60_000;
const MS_PER_SECOND = 1_000;

const label = z
  .string()
  .max(LABEL_MAX_LENGTH)
  .regex(/^[a-zA-Z0-9 ._~+\-[\]"()/:]*$/);
const clickId = z
  .string()
  .max(CLICK_ID_MAX_LENGTH)
  .regex(/^[a-zA-Z0-9_.~-]+$/);

export const acquisitionTouchSchema = z.object({
  at: z.string().datetime(),
  source: label,
  medium: label,
  campaign: label.optional(),
  campaignId: z
    .string()
    .regex(new RegExp(`^\\d{1,${CAMPAIGN_ID_MAX_DIGITS}}$`))
    .optional(),
  adGroupId: z
    .string()
    .regex(new RegExp(`^\\d{1,${CAMPAIGN_ID_MAX_DIGITS}}$`))
    .optional(),
  keyword: label.optional(),
  creative: label.optional(),
  matchType: z.enum(["e", "p", "b", "a"]).optional(),
  gclid: clickId.optional(),
  gbraid: clickId.optional(),
  wbraid: clickId.optional(),
});
export const acquisitionSchema = z.object({
  version: z.literal(1),
  first: acquisitionTouchSchema,
  last: acquisitionTouchSchema,
  clientId: z
    .string()
    .max(CLIENT_ID_MAX_LENGTH)
    .regex(/^\d+\.\d+$/)
    .optional(),
  sessionId: z.string().max(SESSION_ID_MAX_LENGTH).regex(/^\d+$/).optional(),
  sessionCapturedAt: z.string().datetime().optional(),
});
export type Acquisition = z.infer<typeof acquisitionSchema>;

const matchesDomain = (input: { host: string; domain: string }) =>
  input.host === input.domain || input.host.endsWith(`.${input.domain}`);
const ignoredReferrers = [
  "ready.app",
  "ready.new",
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
];
const referralSources: { source: string; medium: string; domains: string[] }[] = [
  {
    source: "google",
    medium: "organic",
    domains: ["google.com", "google.co.uk", "google.ca", "google.com.au", "google.de", "google.fr", "google.co.in"],
  },
  { source: "bing", medium: "organic", domains: ["bing.com"] },
  { source: "duckduckgo", medium: "organic", domains: ["duckduckgo.com"] },
  { source: "yahoo", medium: "organic", domains: ["search.yahoo.com"] },
  { source: "ecosia", medium: "organic", domains: ["ecosia.org"] },
  { source: "brave", medium: "organic", domains: ["search.brave.com"] },
  { source: "linkedin", medium: "social", domains: ["linkedin.com", "lnkd.in"] },
  { source: "facebook", medium: "social", domains: ["facebook.com", "fb.com"] },
  { source: "instagram", medium: "social", domains: ["instagram.com"] },
  { source: "twitter", medium: "social", domains: ["twitter.com", "x.com", "t.co"] },
  { source: "reddit", medium: "social", domains: ["reddit.com", "redd.it"] },
  { source: "youtube", medium: "social", domains: ["youtube.com", "youtu.be"] },
  { source: "tiktok", medium: "social", domains: ["tiktok.com"] },
  { source: "pinterest", medium: "social", domains: ["pinterest.com", "pin.it"] },
];

const readReferringHost = (referrer: string): string => {
  try {
    return new URL(referrer).hostname;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return "";
    }

    return "";
  }
};

function parseAcquisitionCookieImpl(input: { raw: string; now: number }): Acquisition | undefined {
  if (input.raw.length > ACQUISITION_COOKIE_MAX_BYTES) {
    return undefined;
  }
  try {
    const parsed = acquisitionSchema.safeParse(JSON.parse(decodeURIComponent(input.raw)));
    if (!parsed.success) {
      return undefined;
    }
    const { first, last } = parsed.data;
    if (
      [first.at, last.at].some(
        (at) =>
          Date.parse(at) > input.now + ACQUISITION_CLOCK_SKEW_MS ||
          Date.parse(at) < input.now - ACQUISITION_MAX_AGE_SECONDS * MS_PER_SECOND,
      )
    ) {
      return undefined;
    }

    return parsed.data;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return undefined;
    }

    return undefined;
  }
}

export function parseAcquisitionCookie(
  ...args: [string | undefined] | [string | undefined, number]
): Acquisition | undefined {
  const [raw, now = Date.now()] = args;
  if (raw === undefined || raw === "") {
    return undefined;
  }

  return parseAcquisitionCookieImpl({ raw, now });
}

type LandingFieldValues = {
  campaign: string | null;
  campaignId: string | null;
  adGroupId: string | null;
  keyword: string | null;
  creative: string | null;
  matchType: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
};

const readLandingFieldValues = (params: URLSearchParams): LandingFieldValues => ({
  campaign: params.get("utm_campaign"),
  campaignId: params.get("campaign_id"),
  adGroupId: params.get("adgroup_id"),
  keyword: params.get("utm_term"),
  creative: params.get("utm_content"),
  matchType: params.get("matchtype"),
  gclid: params.get("gclid"),
  gbraid: params.get("gbraid"),
  wbraid: params.get("wbraid"),
});

const hasPaidClickId = (fields: LandingFieldValues): boolean =>
  [fields.gclid, fields.gbraid, fields.wbraid].some((value) => clickId.safeParse(value).success);

const isExternalReferringHost = (referringHost: string): boolean =>
  referringHost.length > 0 && !ignoredReferrers.some((domain) => matchesDomain({ host: referringHost, domain }));

const inferReferralSource = (referringHost: string) =>
  referralSources.find(({ domains }) => domains.some((domain) => matchesDomain({ host: referringHost, domain })));

const resolveLandingSource = (input: {
  taggedSource: string | null;
  hasClick: boolean;
  inferredSource?: string;
  referringHost: string;
  isExternalReferrer: boolean;
}): string =>
  input.taggedSource ??
  (input.hasClick ? "google" : (input.inferredSource ?? (input.isExternalReferrer ? input.referringHost : "direct")));

const resolveLandingMedium = (input: {
  taggedMedium: string | null;
  taggedSource: string | null;
  hasClick: boolean;
  inferredMedium?: string;
  isExternalReferrer: boolean;
}): string =>
  input.taggedMedium ??
  (input.hasClick
    ? "cpc"
    : input.taggedSource !== null
      ? "referral"
      : (input.inferredMedium ?? (input.isExternalReferrer ? "referral" : "none")));

const acquisitionFieldKeys = [
  "campaign",
  "campaignId",
  "adGroupId",
  "keyword",
  "creative",
  "matchType",
  "gclid",
  "gbraid",
  "wbraid",
] as const satisfies readonly (keyof LandingFieldValues)[];

const withValidatedTouchFields = (input: {
  touch: z.infer<typeof acquisitionTouchSchema>;
  fields: LandingFieldValues;
}): z.infer<typeof acquisitionTouchSchema> =>
  acquisitionFieldKeys.reduce<z.infer<typeof acquisitionTouchSchema>>((nextTouch, key) => {
    const value = input.fields[key];
    const field = acquisitionTouchSchema.shape[key];
    if (value !== null && value !== "" && field.safeParse(value).success) {
      return { ...nextTouch, [key]: value };
    }

    return nextTouch;
  }, input.touch);

function acquisitionFromLandingImpl(input: {
  url: string;
  referrer: string;
  prior?: Acquisition;
  now: Date;
}): Acquisition {
  const params = new URL(input.url).searchParams;
  const fields = readLandingFieldValues(params);
  const referringHost = readReferringHost(input.referrer);
  const hasClick = hasPaidClickId(fields);
  const isExternalReferrer = isExternalReferringHost(referringHost);
  const inferred = isExternalReferrer ? inferReferralSource(referringHost) : undefined;
  const taggedSource = params.get("utm_source");
  const taggedMedium = params.get("utm_medium");
  const source = resolveLandingSource({
    taggedSource,
    hasClick,
    inferredSource: inferred?.source,
    referringHost,
    isExternalReferrer,
  });
  const medium = resolveLandingMedium({
    taggedMedium,
    taggedSource,
    hasClick,
    inferredMedium: inferred?.medium,
    isExternalReferrer,
  });
  const touch = withValidatedTouchFields({
    touch: {
      at: input.now.toISOString(),
      source: label.safeParse(source).success ? source : "unknown",
      medium: label.safeParse(medium).success ? medium : "unknown",
    },
    fields,
  });
  // Keep last non-direct acquisition through internal navigation and OAuth redirects.
  const isNewAcquisition = taggedSource !== null || hasClick || isExternalReferrer;

  return {
    ...input.prior,
    version: 1,
    first: input.prior?.first ?? touch,
    last: !input.prior || isNewAcquisition ? touch : input.prior.last,
  };
}

/** Only bounded campaign fields are retained; never persist arbitrary URLs or query strings. */
export function acquisitionFromLanding(...args: [string, string, Acquisition?, Date?]): Acquisition {
  const [url, referrer, prior, now = new Date()] = args;

  return acquisitionFromLandingImpl({ url, referrer, prior, now });
}
