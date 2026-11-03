import type { AmbientContextPrivateDetails, MeetingAmbientContextItem } from "@readymeet/shared";

const MAX_AMBIENT_CONTEXT_INITIALS = 2;
const DEFAULT_AMBIENT_CONTEXT_MONOGRAM = "R";
const HEADQUARTERS_NOT_VERIFIED_LABEL = "Headquarters not verified";

export type AmbientContextViewItem = MeetingAmbientContextItem & {
  memoryArrivalVersion?: string;
  selectionAliases?: string[];
  privateImageUrl?: string | null;
  /** @external existing wire contract */
  privateDetailsPending?: boolean;
  privateDetails?: AmbientContextPrivateDetails | null;
};

/** Keep the shared card's identity and research while incorporating private arrivals. */
export function mergeMeetingPeopleMemory(input: {
  sharedItems: AmbientContextViewItem[];
  arrivals: AmbientContextViewItem[];
}): AmbientContextViewItem[] {
  return input.arrivals.reduce<AmbientContextViewItem[]>(
    (items, arrival) => {
      const memory = arrival.privateDetails?.memory;
      if (memory === undefined || memory === null) {
        return [...items, arrival];
      }
      const matches = items.filter((item) => item.privateDetails?.memory?.personId === memory.personId);
      const existing = matches.reduce<AmbientContextViewItem | undefined>(
        (latest, item) =>
          latest === undefined || ambientContextPillTimestamp(item) > ambientContextPillTimestamp(latest)
            ? item
            : latest,
        undefined,
      );
      if (existing === undefined) {
        return [...items, arrival];
      }
      const arrivalAt = arrival.researchCompletedAt ?? arrival.lastMentionedAt;
      const existingIndex = items.findIndex((item) => item === existing);
      if (existingIndex === -1) {
        return items;
      }

      return items.map((item, index) =>
        index === existingIndex
          ? {
              ...existing,
              researchCompletedAt:
                Date.parse(arrivalAt) > Date.parse(existing.researchCompletedAt ?? existing.lastMentionedAt)
                  ? arrivalAt
                  : existing.researchCompletedAt,
              privateDetails: { memory, ashby: existing.privateDetails?.ashby ?? null },
              privateImageUrl: arrival.privateImageUrl,
              memoryArrivalVersion: arrival.memoryArrivalVersion,
              selectionAliases: [...new Set([...(existing.selectionAliases ?? []), arrival.id])],
            }
          : item,
      );
    },
    [...input.sharedItems],
  );
}

export function meetingContextImageUrls(input: {
  items: AmbientContextViewItem[];
  researchImages: Record<string, string>;
}): Record<string, string> {
  return input.items.reduce<Record<string, string>>(
    (images, item) => {
      const imageUrl =
        item.privateImageUrl !== undefined ? item.privateImageUrl : item.privateDetails?.memory?.imageUrl;
      if (imageUrl !== undefined && imageUrl !== null && imageUrl.length > 0) {
        return { ...images, [item.id]: imageUrl };
      }
      if (item.privateImageUrl !== undefined) {
        const { [item.id]: _removed, ...rest } = images;

        return rest;
      }

      return images;
    },
    { ...input.researchImages },
  );
}

export function ambientContextPrivateDetails(item: AmbientContextViewItem): AmbientContextPrivateDetails | null {
  return item.privateDetails ?? null;
}

export function ambientContextMonogram(item: MeetingAmbientContextItem): string {
  const source = item.entityKind === "company" ? item.displayName.replace(/[^a-z0-9 ]/gi, " ") : item.displayName;
  const parts = source.trim().split(/\s+/).filter(Boolean);

  const monogram = `${parts[0]?.[0] ?? ""}${parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : (parts[0]?.[1] ?? "")}`
    .toUpperCase()
    .slice(0, MAX_AMBIENT_CONTEXT_INITIALS);

  return monogram.length > 0 ? monogram : DEFAULT_AMBIENT_CONTEXT_MONOGRAM;
}

export function ambientContextSecondaryLine(item: AmbientContextViewItem): string {
  if (item.entityKind === "company") {
    return item.headquarters ?? HEADQUARTERS_NOT_VERIFIED_LABEL;
  }
  const professionalTitle = item.professionalTitle;
  if (professionalTitle === null || professionalTitle.length === 0) {
    const companyName = item.companyName ?? "";
    const memoryEmail = item.privateDetails?.memory?.email?.trim() ?? "";

    return companyName.length > 0 ? companyName : memoryEmail;
  }

  const companyName = item.companyName;
  if (companyName !== null && companyName.length > 0) {
    return `${professionalTitle} · ${companyName}`;
  }

  return professionalTitle;
}

type AmbientContextPillPresentation = {
  phase: "loading" | "result";
  label: string;
  subjectId: string;
};

export function ambientContextItemHasReadableResult(item: AmbientContextViewItem): boolean {
  // Follow-up research retains the last usable result while updating its fields.
  const summaryText = item.summary?.trim() ?? "";

  return (
    (item.privateDetails?.memory !== undefined && item.privateDetails.memory !== null) ||
    (item.privateDetails?.ashby !== undefined && item.privateDetails.ashby !== null) ||
    summaryText.length > 0 ||
    item.facts.length !== 0 ||
    item.citations.length !== 0
  );
}

export function ambientContextItemIsResearching(
  item: Pick<AmbientContextViewItem, "status" | "privateDetailsPending">,
): boolean {
  return item.privateDetailsPending === true || item.status === "pending" || item.status === "researching";
}

function ambientContextItemIsPresentable(item: MeetingAmbientContextItem): boolean {
  return ambientContextItemIsResearching(item) || ambientContextItemHasReadableResult(item);
}

export function ambientContextPillTimestamp(item: MeetingAmbientContextItem): number {
  return Math.max(
    Date.parse(item.lastMentionedAt),
    ambientContextItemHasReadableResult(item) ? Date.parse(item.researchCompletedAt ?? item.lastMentionedAt) : 0,
  );
}

export function ambientContextPillPresentation(
  items: MeetingAmbientContextItem[],
): AmbientContextPillPresentation | null {
  const latestItem = items.reduce<MeetingAmbientContextItem | null>((latest, item) => {
    if (!ambientContextItemIsPresentable(item)) {
      return latest;
    }
    if (
      latest === null ||
      ambientContextPillTimestamp(item) > ambientContextPillTimestamp(latest) ||
      (ambientContextPillTimestamp(item) === ambientContextPillTimestamp(latest) &&
        ambientContextItemHasReadableResult(item) &&
        !ambientContextItemHasReadableResult(latest))
    ) {
      return item;
    }

    return latest;
  }, null);
  if (latestItem !== null) {
    return {
      phase: ambientContextItemHasReadableResult(latestItem) ? "result" : "loading",
      label: latestItem.displayName,
      subjectId: latestItem.id,
    };
  }

  return null;
}
