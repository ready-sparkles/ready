import { DEMO_MEETINGS, DEMO_PEOPLE, DEMO_UPCOMING } from "../../../domain/workspace-demo/demo-fixtures";
import { DEMO_PERSON_BY, DEMO_PERSON_BY_COMPANY } from "../../../domain/workspace-demo/personby";

export type DemoMinutes = {
  id: string;
  title: string;
  date: string;
  status: "Draft" | "Approved";
  sections: { heading: string; text: string }[];
};
export type DemoRoom = {
  id: string;
  name: string;
  country: string;
  members: string[];
  agenda: string[];
  tasks: { id: string; title: string; owner: string; isDone: boolean }[];
  minutes: DemoMinutes[];
};
const FEATURED_UPCOMING_MEETING_COUNT = 6;
const DEMO_MEETING_COUNT = 8;

const OPENING_SECTION_HEADING = "1. Opening and attendance";
const BUSINESS_SECTION_HEADING = "2. Business review";
const FINANCIAL_SECTION_HEADING = "3. Financial outlook";
const RESOLUTIONS_SECTION_HEADING = "4. Resolutions";
const FOLLOW_UP_SECTION_HEADING = "5. Follow-up and closing";

const FINANCIAL_OUTLOOK_SECTION_TEXT =
  "The volunteers agreed to use the craft materials already on the shelf. They will list any missing supplies after trying the paper prototype.";

const MERIDIAN_BUSINESS_SECTION_TEXT =
  "Jordan presented a paper visitor map for the fictional Meridian museum. The group discussed picture labels, an activity table, and a quiet corner.";

const OCEAN_BUSINESS_SECTION_TEXT =
  "Riley presented the partnership update. The board reviewed the current pipeline, partner responsibilities, and the resources required for the next phase. Members agreed to prioritize existing relationships before expanding the programme.";

const MERIDIAN_RESOLUTIONS_SECTION_TEXT =
  "RESOLVED: Try the paper visitor map at the next volunteer session. Review the labels together before assembling the exhibit.";

const OCEAN_RESOLUTIONS_SECTION_TEXT =
  "RESOLVED: Management will prepare a partnership operating plan with named owners, milestones, and a proposed budget. Any material commercial commitments remain subject to a separate board approval.";

const FOLLOW_UP_SECTION_TEXT =
  "Management will report on the agreed actions at the next board meeting. The chair closed the meeting after confirming that there was no further business. These illustrative draft minutes are ready for review.";

export const demoPeople = ["Avery", DEMO_PERSON_BY, "Riley", "Casey"];
export const demoPortraits = Object.fromEntries(DEMO_PEOPLE.map((person) => [person.name, person.imageUrl]));
export const demoUpcoming = DEMO_UPCOMING.slice(0, FEATURED_UPCOMING_MEETING_COUNT);
export const demoMeetings = DEMO_MEETINGS.slice(0, DEMO_MEETING_COUNT);
export const features = ["Board", "Sales", "Recruiting", "Partners"] as const;
export type Feature = (typeof features)[number];

export function makeMinutes(input: {
  room: Pick<DemoRoom, "id" | "name" | "members">;
  id: string;
  title: string;
  date: string;
}): DemoMinutes {
  const isMeridian = input.room.id === "meridian";
  const openingSectionText = `The chair opened the meeting of ${input.room.name}. Present: ${input.room.members.join(", ")}. The agenda was adopted and the meeting was declared quorate.`;

  return {
    id: input.id,
    title: input.title,
    date: input.date,
    status: "Draft",
    sections: [
      {
        heading: OPENING_SECTION_HEADING,
        text: openingSectionText,
      },
      {
        heading: BUSINESS_SECTION_HEADING,
        text: isMeridian ? MERIDIAN_BUSINESS_SECTION_TEXT : OCEAN_BUSINESS_SECTION_TEXT,
      },
      {
        heading: FINANCIAL_SECTION_HEADING,
        text: FINANCIAL_OUTLOOK_SECTION_TEXT,
      },
      {
        heading: RESOLUTIONS_SECTION_HEADING,
        text: isMeridian ? MERIDIAN_RESOLUTIONS_SECTION_TEXT : OCEAN_RESOLUTIONS_SECTION_TEXT,
      },
      {
        heading: FOLLOW_UP_SECTION_HEADING,
        text: FOLLOW_UP_SECTION_TEXT,
      },
    ],
  };
}

export function createDemoRooms(): DemoRoom[] {
  return [
    {
      id: "meridian",
      name: DEMO_PERSON_BY_COMPANY,
      country: "Finland",
      members: ["Avery", DEMO_PERSON_BY],
      agenda: ["Visitor route", "Picture labels", "Volunteer roles", "Quiet corner"],
      tasks: [
        {
          id: "forecast",
          title: "Share the visitor-route sketch",
          owner: "Avery",
          isDone: false,
        },
        { id: "data", title: "Review the picture labels", owner: DEMO_PERSON_BY, isDone: false },
        { id: "hiring", title: "Share the workshop activity guide", owner: DEMO_PERSON_BY, isDone: true },
      ],
      minutes: [],
    },
    {
      id: "ocean",
      name: "Ocean & Co.",
      country: "United States",
      members: ["Avery", "Riley", "Casey"],
      agenda: ["Partnership pipeline", "Operating plan", "Budget and responsibilities"],
      tasks: [
        {
          id: "partners",
          title: "Prepare the partnership operating plan",
          owner: "Riley",
          isDone: false,
        },
        { id: "budget", title: "Review the proposed budget", owner: "Casey", isDone: false },
      ],
      minutes: [],
    },
  ].map((room) => ({
    ...room,
    minutes: [
      makeMinutes({
        room,
        id: `${room.id}-sept`,
        title: "September board meeting",
        date: "September 24, 2026",
      }),
      {
        ...makeMinutes({
          room,
          id: `${room.id}-aug`,
          title: "August board meeting",
          date: "August 27, 2026",
        }),
        status: "Approved" as const,
      },
    ],
  }));
}
