const MILLISECONDS_PER_DAY = 86_400_000;
const MONTHS_PER_YEAR = 12;

export function formatReleaseAge(input: { date: string; fullDate: string; now?: Date }): string {
  const now = input.now ?? new Date();
  const { date, fullDate } = input;
  // Compare calendar days in the reader's timezone, without DST-hour drift.
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const published = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(published) || today < published) {
    return fullDate;
  }
  const days = Math.round((today - published) / MILLISECONDS_PER_DAY);
  if (days === 0) {
    return "Today";
  }
  if (days === 1) {
    return "Yesterday";
  }

  const start = new Date(published);
  const anniversary = (count: number) => {
    const year = start.getUTCFullYear();
    const month = start.getUTCMonth() + count;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

    return Date.UTC(year, month, Math.min(start.getUTCDate(), lastDay));
  };
  const rawMonths =
    (now.getFullYear() - start.getUTCFullYear()) * MONTHS_PER_YEAR + now.getMonth() - start.getUTCMonth();
  const months = anniversary(rawMonths) > today ? rawMonths - 1 : rawMonths;
  if (months === 0) {
    return `${days} days ago`;
  }

  const remainingDays = Math.round((today - anniversary(months)) / MILLISECONDS_PER_DAY);
  const monthLabel = `${months} ${months === 1 ? "month" : "months"}`;

  return remainingDays === 0
    ? `${monthLabel} ago`
    : `${monthLabel}, ${remainingDays} ${remainingDays === 1 ? "day" : "days"} ago`;
}
