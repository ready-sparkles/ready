const FALLBACK_DAY = 1;

export type DayLogoTone = "brand" | "mono" | "memory";

const DAY_LOGO_FOLDERS: Record<DayLogoTone, string> = {
  brand: "days",
  mono: "days-mono",
  memory: "days-memory",
};

export function getDayIconHref({
  dayNumber = FALLBACK_DAY,
  tone = "brand",
}: { dayNumber?: number; tone?: DayLogoTone } = {}): string {
  return `/logos/${DAY_LOGO_FOLDERS[tone]}/${dayNumber}.svg`;
}
