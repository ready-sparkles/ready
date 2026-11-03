// Meeting briefs for the demo's upcoming calls, written the way the real brief
// reads: why the call matters, what each person needs, and where it came from.
// Sources that are past meetings open inside the demo; email, Slack, and
// LinkedIn sources are illustrative and never navigate away.

export type UpcomingBriefSource =
  | { kind: "meeting"; title: string; meetingId: string }
  | { kind: "email" | "slack" | "linkedin"; title: string };

type UpcomingBrief = {
  brief: string[];
  people: string[];
  company: { name: string; bullets: string[] } | null;
  sources: UpcomingBriefSource[];
};

export const UPCOMING_BRIEFS: Record<string, UpcomingBrief> = {
  "danny-plan-walkthrough": {
    brief: [
      "Hear Danny’s full plan in person and decide whether to take one of the eleven parts. Come with an answer on security.",
    ],
    people: [
      "Danny Ocean: Wants a yes or no on your part today. He keeps the plan off email, so this is the first time you’ll see all of it.",
      "Rusty Ryan: Set up the lunch and is your point of contact afterwards. Route follow-up questions through him.",
      "Open item: You promised to review the security requirements with Livingston before this call.",
      "Budget: Danny says Reuben has agreed to fund the project. Ask what that covers before committing.",
    ],
    company: {
      name: "Ocean & Co.",
      bullets: [
        "Danny’s firm. The project depends on three launches running on the same night, each owned by one specialist.",
      ],
    },
    sources: [
      { kind: "meeting", title: "Danny · Crew and timeline", meetingId: "danny-crew-timeline" },
      { kind: "meeting", title: "Danny · Intro over lunch", meetingId: "danny-intro-lunch" },
      { kind: "email", title: "Rusty: Meet Danny, over food" },
      { kind: "email", title: "Danny: Let’s go through the plan in person" },
    ],
  },
  "website-launch-check-in": {
    brief: [
      "Decide whether the new website can launch on Friday. The pages are done; mobile signup and the final pricing check are the two open items.",
    ],
    people: [
      "Maya Lin: Home and pricing pages are approved and updated on the test site. She’s done unless the pricing table changes.",
      "Marcus Lee: One bug left: signup on phones sometimes doesn’t respond. He’s fixing it and retesting before this call.",
      "Nina Patel: Comparing monthly and annual prices on the new page with billing. She said she’d have it checked for today.",
      "Your call: Once mobile signup passes and pricing matches, you give the go-ahead for Friday.",
    ],
    company: null,
    sources: [
      { kind: "meeting", title: "Website launch planning", meetingId: "website-kickoff" },
      { kind: "email", title: "Maya Lin: Home and pricing pages approved" },
      { kind: "slack", title: "#website-launch · Mobile signup bug" },
      { kind: "email", title: "Nina: Final pricing check for Friday’s launch" },
    ],
  },
  "sophie-rollout-next-steps": {
    brief: ["Send Sophie the updated forecast and review the decisions holding up Meridian’s rollout."],
    people: [
      "Sophie Chen: COO, Meridian. Working with you on the rollout and next phase of growth.",
      "Pricing still needs final approval. Two key hires are still open.",
      "The rollout can move forward once customer data is validated.",
    ],
    company: { name: "Meridian", bullets: ["Europe expansion is now pushed to Q1"] },
    sources: [
      { kind: "meeting", title: "Meridian · Rollout review", meetingId: "zoom-m-172" },
      { kind: "meeting", title: "Meridian · Pricing and hiring", meetingId: "zoom-m-167" },
    ],
  },
};
