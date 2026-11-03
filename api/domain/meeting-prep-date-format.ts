const MONTH_JANUARY = 1;
const MONTH_FEBRUARY = 2;
const MONTH_MARCH = 3;
const MONTH_APRIL = 4;
const MONTH_MAY = 5;
const MONTH_JUNE = 6;
const MONTH_JULY = 7;
const MONTH_AUGUST = 8;
const MONTH_SEPTEMBER = 9;
const MONTH_OCTOBER = 10;
const MONTH_NOVEMBER = 11;
const MONTH_DECEMBER = 12;
const MONTH_MIN = MONTH_JANUARY;
const MONTH_MAX = MONTH_DECEMBER;
const DAY_MIN = 1;
const DAY_MAX = 31;
const UTC_MONTH_OFFSET = 1;

const MONTH_NUMBERS: Record<string, number> = {
  jan: MONTH_JANUARY,
  january: MONTH_JANUARY,
  feb: MONTH_FEBRUARY,
  february: MONTH_FEBRUARY,
  mar: MONTH_MARCH,
  march: MONTH_MARCH,
  apr: MONTH_APRIL,
  april: MONTH_APRIL,
  may: MONTH_MAY,
  jun: MONTH_JUNE,
  june: MONTH_JUNE,
  jul: MONTH_JULY,
  july: MONTH_JULY,
  aug: MONTH_AUGUST,
  august: MONTH_AUGUST,
  sep: MONTH_SEPTEMBER,
  sept: MONTH_SEPTEMBER,
  september: MONTH_SEPTEMBER,
  oct: MONTH_OCTOBER,
  october: MONTH_OCTOBER,
  nov: MONTH_NOVEMBER,
  november: MONTH_NOVEMBER,
  dec: MONTH_DECEMBER,
  december: MONTH_DECEMBER,
};

function asText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function validMonth(value: string) {
  const month = Number(value);

  return Number.isInteger(month) && month >= MONTH_MIN && month <= MONTH_MAX;
}

function validDay(value: string) {
  const day = Number(value);

  return Number.isInteger(day) && day >= DAY_MIN && day <= DAY_MAX;
}

function formatIsoFullDate(text: string) {
  const fullDateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const [, fullYear, fullMonth, fullDay] = fullDateMatch ?? [];
  if (
    fullYear !== undefined &&
    fullMonth !== undefined &&
    fullDay !== undefined &&
    validMonth(fullMonth) &&
    validDay(fullDay)
  ) {
    return `${Number(fullMonth)}/${Number(fullDay)}/${fullYear}`;
  }

  return null;
}

function formatIsoMonthYear(text: string) {
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(text);
  const [, monthYear, monthOnly] = monthMatch ?? [];
  if (monthYear !== undefined && monthOnly !== undefined && validMonth(monthOnly)) {
    return `${Number(monthOnly)}/${monthYear}`;
  }

  return null;
}

function formatYearOnly(text: string) {
  const yearMatch = /^(\d{4})$/.exec(text);
  const [, yearOnly] = yearMatch ?? [];
  if (yearOnly !== undefined && yearOnly !== "") {
    return yearOnly;
  }

  return null;
}

function formatNaturalFullDate(text: string) {
  const naturalFullDateMatch =
    /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,\s+(\d{4})$/i.exec(
      text,
    );
  const [, naturalFullMonthName, naturalFullDay, naturalFullYear] = naturalFullDateMatch ?? [];
  const naturalFullMonth =
    naturalFullMonthName !== undefined && naturalFullMonthName !== ""
      ? MONTH_NUMBERS[naturalFullMonthName.toLowerCase()]
      : null;
  if (
    naturalFullMonth !== null &&
    naturalFullMonth !== undefined &&
    naturalFullDay !== undefined &&
    naturalFullYear !== undefined &&
    validDay(naturalFullDay)
  ) {
    return `${naturalFullMonth}/${Number(naturalFullDay)}/${naturalFullYear}`;
  }

  return null;
}

function formatNaturalMonthYear(text: string) {
  const naturalMonthMatch =
    /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{4})$/i.exec(
      text,
    );
  const [, naturalMonthName, naturalYear] = naturalMonthMatch ?? [];
  const naturalMonth =
    naturalMonthName !== undefined && naturalMonthName !== "" ? MONTH_NUMBERS[naturalMonthName.toLowerCase()] : null;
  if (naturalMonth !== null && naturalMonth !== undefined && naturalYear !== undefined) {
    return `${naturalMonth}/${naturalYear}`;
  }

  return null;
}

function formatParsedDate(text: string) {
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getUTCMonth() + UTC_MONTH_OFFSET}/${parsed.getUTCDate()}/${parsed.getUTCFullYear()}`;
  }

  return null;
}

export function formatMeetingPrepDate(value: unknown): string {
  const text = asText(value);
  if (text === "") {
    return "";
  }

  return (
    formatIsoFullDate(text) ??
    formatIsoMonthYear(text) ??
    formatYearOnly(text) ??
    formatNaturalFullDate(text) ??
    formatNaturalMonthYear(text) ??
    formatParsedDate(text) ??
    text
  );
}

export function normalizeMeetingPrepDateText(value: string): string {
  return value
    .replace(
      /\b(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
      (_match, year: string, month: string, day: string) =>
        validMonth(month) && validDay(day) ? `${Number(month)}/${Number(day)}/${year}` : `${year}-${month}-${day}`,
    )
    .replace(/\b(\d{4})-(\d{2})\b/g, (_match, year: string, month: string) =>
      validMonth(month) ? `${Number(month)}/${year}` : `${year}-${month}`,
    )
    .replace(
      /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,\s+(\d{4})\b/gi,
      (match, monthName: string, day: string, year: string) => {
        const month = MONTH_NUMBERS[monthName.toLowerCase()];

        return month !== undefined && validDay(day) ? `${month}/${Number(day)}/${year}` : match;
      },
    )
    .replace(
      /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{4})\b/gi,
      (match, monthName: string, year: string) => {
        const month = MONTH_NUMBERS[monthName.toLowerCase()];

        return month !== undefined ? `${month}/${year}` : match;
      },
    )
    .replace(
      /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(\d{4})\b/g,
      (_match, month: string, day: string, year: string) => `${Number(month)}/${Number(day)}/${year}`,
    );
}
