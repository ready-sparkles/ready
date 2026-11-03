// Bounded illustrative records for the public workspace demo.
// Dates shift at runtime while the featured card keeps its editorial timestamp.
import type { MemoryPerson } from "@readymeet/shared";

import { demoId } from "./demo-ids";
import type { CandidateInterview, DemoMoment, PersonPreview, TranscriptTurn } from "./demo-types";
import { SOPHIE_CHEN, SOPHIE_SOURCES, SOPHIE_STANDING, SOPHIE_SUMMARY } from "./sophie-chen";

const DEMO_DURATION_MIN_27 = 27;
const DEMO_DURATION_MIN_28 = 28;
const DEMO_DURATION_MIN_31 = 31;
const DEMO_DURATION_MIN_35 = 35;
const DEMO_DURATION_MIN_45 = 45;
const DEMO_TRANSCRIPT_SECONDS_8 = 8;
const DEMO_TRANSCRIPT_SECONDS_14 = 14;
const DEMO_TRANSCRIPT_SECONDS_25 = 25;
const DEMO_TRANSCRIPT_SECONDS_27 = 27;
const DEMO_TRANSCRIPT_SECONDS_28 = 28;
const DEMO_TRANSCRIPT_SECONDS_30 = 30;
const DEMO_TRANSCRIPT_SECONDS_31 = 31;
const DEMO_TRANSCRIPT_SECONDS_36 = 36;
const DEMO_TRANSCRIPT_SECONDS_43 = 43;
const DEMO_TRANSCRIPT_SECONDS_48 = 48;
const DEMO_TRANSCRIPT_SECONDS_53 = 53;
const DEMO_TRANSCRIPT_SECONDS_56 = 56;
const DEMO_TRANSCRIPT_SECONDS_60 = 60;
const DEMO_TRANSCRIPT_SECONDS_61 = 61;
const DEMO_TRANSCRIPT_SECONDS_79 = 79;
const DEMO_TRANSCRIPT_SECONDS_80 = 80;
const DEMO_TRANSCRIPT_SECONDS_83 = 83;
const DEMO_TRANSCRIPT_SECONDS_85 = 85;
const DEMO_TRANSCRIPT_SECONDS_90 = 90;
const DEMO_TRANSCRIPT_SECONDS_97 = 97;
const DEMO_TRANSCRIPT_SECONDS_107 = 107;
const DEMO_TRANSCRIPT_SECONDS_113 = 113;
const DEMO_TRANSCRIPT_SECONDS_115 = 115;
const DEMO_TRANSCRIPT_SECONDS_120 = 120;
const DEMO_TRANSCRIPT_SECONDS_133 = 133;
const DEMO_TRANSCRIPT_SECONDS_135 = 135;
const DEMO_TRANSCRIPT_SECONDS_141 = 141;
const DEMO_TRANSCRIPT_SECONDS_150 = 150;
const DEMO_TRANSCRIPT_SECONDS_160 = 160;
const DEMO_TRANSCRIPT_SECONDS_167 = 167;
const DEMO_TRANSCRIPT_SECONDS_169 = 169;
const DEMO_TRANSCRIPT_SECONDS_180 = 180;
const DEMO_TRANSCRIPT_SECONDS_187 = 187;
const DEMO_TRANSCRIPT_SECONDS_198 = 198;
const DEMO_TRANSCRIPT_SECONDS_210 = 210;
const DEMO_TRANSCRIPT_SECONDS_213 = 213;
const DEMO_TRANSCRIPT_SECONDS_226 = 226;
const DEMO_TRANSCRIPT_SECONDS_240 = 240;
const DEMO_TRANSCRIPT_SECONDS_250 = 250;
const DEMO_TRANSCRIPT_SECONDS_254 = 254;
const DEMO_TRANSCRIPT_SECONDS_267 = 267;
const DEMO_TRANSCRIPT_SECONDS_270 = 270;
const DEMO_TRANSCRIPT_SECONDS_282 = 282;
const DEMO_TRANSCRIPT_SECONDS_293 = 293;
const DEMO_TRANSCRIPT_SECONDS_300 = 300;
const DEMO_TRANSCRIPT_SECONDS_309 = 309;
const DEMO_TRANSCRIPT_SECONDS_311 = 311;
const DEMO_TRANSCRIPT_SECONDS_312 = 312;
const DEMO_TRANSCRIPT_SECONDS_318 = 318;
const DEMO_TRANSCRIPT_SECONDS_320 = 320;
const DEMO_TRANSCRIPT_SECONDS_330 = 330;
const DEMO_TRANSCRIPT_SECONDS_334 = 334;
const DEMO_TRANSCRIPT_SECONDS_339 = 339;
const DEMO_TRANSCRIPT_SECONDS_347 = 347;
const DEMO_TRANSCRIPT_SECONDS_355 = 355;
const DEMO_TRANSCRIPT_SECONDS_360 = 360;
const DEMO_TRANSCRIPT_SECONDS_367 = 367;
const DEMO_TRANSCRIPT_SECONDS_373 = 373;
const DEMO_TRANSCRIPT_SECONDS_390 = 390;
const DEMO_TRANSCRIPT_SECONDS_395 = 395;
const DEMO_TRANSCRIPT_SECONDS_400 = 400;
const DEMO_TRANSCRIPT_SECONDS_417 = 417;
const DEMO_TRANSCRIPT_SECONDS_420 = 420;
const DEMO_TRANSCRIPT_SECONDS_424 = 424;
const DEMO_TRANSCRIPT_SECONDS_427 = 427;
const DEMO_TRANSCRIPT_SECONDS_435 = 435;
const DEMO_TRANSCRIPT_SECONDS_450 = 450;
const DEMO_TRANSCRIPT_SECONDS_452 = 452;
const DEMO_TRANSCRIPT_SECONDS_453 = 453;
const DEMO_TRANSCRIPT_SECONDS_480 = 480;
const DEMO_TRANSCRIPT_SECONDS_501 = 501;
const DEMO_TRANSCRIPT_SECONDS_570 = 570;
const DEMO_TRANSCRIPT_SECONDS_584 = 584;
const DEMO_TRANSCRIPT_SECONDS_668 = 668;
const DEMO_TRANSCRIPT_SECONDS_690 = 690;
const DEMO_TRANSCRIPT_SECONDS_751 = 751;
const DEMO_TRANSCRIPT_SECONDS_815 = 815;
const DEMO_TRANSCRIPT_SECONDS_835 = 835;
const DEMO_TRANSCRIPT_SECONDS_918 = 918;
const DEMO_TRANSCRIPT_SECONDS_940 = 940;
const DEMO_TRANSCRIPT_SECONDS_1002 = 1002;
const DEMO_TRANSCRIPT_SECONDS_1050 = 1050;
const DEMO_TRANSCRIPT_SECONDS_1085 = 1085;
const DEMO_TRANSCRIPT_SECONDS_1169 = 1169;
const DEMO_TRANSCRIPT_SECONDS_1180 = 1180;
const DEMO_TRANSCRIPT_SECONDS_1252 = 1252;
const DEMO_TRANSCRIPT_SECONDS_1305 = 1305;
const DEMO_TRANSCRIPT_SECONDS_1320 = 1320;
const DEMO_TRANSCRIPT_SECONDS_1328 = 1328;
const DEMO_TRANSCRIPT_SECONDS_1336 = 1336;
const DEMO_TRANSCRIPT_SECONDS_1419 = 1419;
const DEMO_TRANSCRIPT_SECONDS_1430 = 1430;
const DEMO_TRANSCRIPT_SECONDS_1440 = 1440;
const DEMO_TRANSCRIPT_SECONDS_1446 = 1446;
const DEMO_TRANSCRIPT_SECONDS_1503 = 1503;
const DEMO_TRANSCRIPT_SECONDS_1540 = 1540;
const DEMO_TRANSCRIPT_SECONDS_1586 = 1586;
const DEMO_TRANSCRIPT_SECONDS_1670 = 1670;
const DEMO_TRANSCRIPT_SECONDS_1753 = 1753;
const DEMO_TRANSCRIPT_SECONDS_1800 = 1800;
const DEMO_TRANSCRIPT_SECONDS_1837 = 1837;
const DEMO_TRANSCRIPT_SECONDS_1920 = 1920;
const DEMO_TRANSCRIPT_SECONDS_1935 = 1935;
const DEMO_TRANSCRIPT_SECONDS_1965 = 1965;
const DEMO_TRANSCRIPT_SECONDS_2000 = 2000;
const DEMO_TRANSCRIPT_SECONDS_2035 = 2035;
const DEMO_TRANSCRIPT_SECONDS_2045 = 2045;
const DEMO_TRANSCRIPT_SECONDS_2065 = 2065;
const DEMO_TRANSCRIPT_SECONDS_2090 = 2090;
const DEMO_TRANSCRIPT_SECONDS_2400 = 2400;
const DEMO_TRANSCRIPT_SECONDS_2406 = 2406;

export const DEMO_PEOPLE: MemoryPerson[] = [
  {
    id: "e786b798-9853-45d3-9ee0-d67cce925a1b",
    name: "Danny Ocean",
    email: "danny@oceanandcohq.com",
    lastContact: "2026-09-04T22:40:00.000Z",
    categories: ["Partnerships"],
    companyName: "Ocean & Co.",
    companyDomain: "oceanandcohq.com",
    imageUrl: "/landing/danny-ocean.webp",
    profileLinks: [
      {
        label: "Ashby",
        url: "https://app.ashbyhq.com/",
      },
      {
        label: "LinkedIn",
        url: "https://www.linkedin.com/",
      },
      {
        label: "GitHub",
        url: "https://github.com/",
      },
      {
        label: "X",
        url: "https://x.com/",
      },
    ],
  },
  {
    id: "20d227f5-f5d4-4c07-b3ce-328ad6d8c710",
    name: "Rusty Ryan",
    email: "rusty@oceanandcohq.com",
    lastContact: "2026-09-04T22:40:00.000Z",
    categories: ["Partnerships"],
    companyName: "Ocean & Co.",
    companyDomain: "oceanandcohq.com",
    imageUrl: "/landing/rusty-ryan.webp",
  },
  {
    id: "74d6b365-7f9e-40d3-b42a-1e50d2a6125f",
    name: "Elena",
    email: "elena@ready.app",
    lastContact: "2026-08-28T17:18:00.000Z",
    categories: ["Recruiting"],
    companyName: "Ready",
    companyDomain: "ready.app",
    imageUrl: "/landing/people/elena.webp",
  },
  {
    id: "039038d9-884b-4532-8f60-7eb3f83e6609",
    name: "Marcus Lee",
    email: "marcus@ready.app",
    lastContact: "2026-08-28T17:18:00.000Z",
    categories: ["Recruiting"],
    companyName: "Ready",
    companyDomain: "ready.app",
    imageUrl: "/landing/people/marcus-lee.webp",
  },
  {
    id: demoId(`person:${SOPHIE_CHEN}`),
    name: "Sophie Chen",
    email: "sophie@example.com",
    lastContact: "2026-08-28T16:34:00.000Z",
    categories: ["Projects"],
    companyName: "Meridian",
    companyDomain: "example.com",
    imageUrl: "/landing/people/sophie-chen.webp",
    profileLinks: SOPHIE_SOURCES.map((source) => ({ label: source.domain, url: source.url })),
  },
  {
    id: "714dbb13-9b4a-4506-b134-600290da391d",
    name: "Nia Brooks",
    email: "nia@meridiancloudhq.com",
    lastContact: "2026-08-28T15:45:00.000Z",
    categories: ["Recruiting"],
    companyName: "Meridian Cloud",
    companyDomain: "meridiancloudhq.com",
    imageUrl: "/landing/people/nia-brooks.webp",
  },
  {
    id: "db88c25d-5e56-48d6-9ddb-8f57e0c1a8a0",
    name: "Sergei Volkov",
    email: "sergei@ready.app",
    lastContact: "2026-08-27T23:32:00.000Z",
    categories: ["Recruiting"],
    companyName: "Ready",
    companyDomain: "ready.app",
    imageUrl: "/landing/people/sergei-volkov.webp",
  },
  {
    id: "5f646950-fcac-47f6-8c6b-52b3d8a8ee9b",
    name: "Tomas Vane",
    email: "tomas@meridiancloudhq.com",
    lastContact: "2026-08-27T22:16:00.000Z",
    categories: ["Recruiting"],
    companyName: "Meridian Cloud",
    companyDomain: "meridiancloudhq.com",
    imageUrl: "/landing/people/tomas-vane.webp",
  },
  {
    id: "be2ff06a-4613-4b90-8004-ccf6f24dc709",
    name: "Leo Chen",
    email: "leo@northstarlabs.com",
    lastContact: "2026-08-27T21:30:00.000Z",
    categories: ["Recruiting"],
    companyName: "Northstar Labs",
    companyDomain: "northstarlabs.com",
    imageUrl: "/landing/people/leo-chen.webp",
  },
  {
    id: "74afaeb1-283b-449b-b5a6-2933553f3007",
    name: "Dana Okafor",
    email: "dana@beaconhealthhq.com",
    lastContact: "2026-08-27T19:47:00.000Z",
    categories: ["Recruiting"],
    companyName: "Beacon Health",
    companyDomain: "beaconhealthhq.com",
    imageUrl: "/landing/people/dana-okafor.webp",
  },
  {
    id: "90534e26-cf31-4725-93bc-f15a82ec652d",
    name: "Anna Kowalski",
    email: "anna@cedarlabshq.com",
    lastContact: "2026-08-27T17:18:00.000Z",
    categories: ["Recruiting"],
    companyName: "Cedar Labs",
    companyDomain: "cedarlabshq.com",
    imageUrl: "/landing/people/anna-kowalski.webp",
  },
  {
    id: "62b985a6-179e-4cdc-a775-88fcf5df6d86",
    name: "Marta Silva",
    email: "marta@ready.app",
    lastContact: "2026-08-26T23:32:00.000Z",
    categories: ["Recruiting"],
    companyName: "Ready",
    companyDomain: "ready.app",
    imageUrl: "/landing/people/marta-silva.webp",
  },
  {
    id: "cd5a25dd-e241-49a8-8ce4-6084e7cf7700",
    name: "Maya Torres",
    email: "maya@northstarlabs.com",
    lastContact: "2026-08-26T15:12:00.000Z",
    categories: ["Customers"],
    companyName: "Northstar Labs",
    companyDomain: "northstarlabs.com",
    imageUrl: "/landing/people/maya-torres.webp",
  },
  {
    id: "14f1680e-2a9f-4492-ba9e-67d2b0028f8f",
    name: "Peter Lawson",
    email: "peter@cedarlabshq.com",
    lastContact: "2026-08-22T21:46:00.000Z",
    categories: ["Customers"],
    companyName: "Cedar Labs",
    companyDomain: "cedarlabshq.com",
    imageUrl: "/landing/people/peter-lawson.webp",
  },
  {
    id: "4d2fecb2-303e-4c33-901d-763dc628cd20",
    name: "Tom Ellis",
    email: "tom@northstarlabs.com",
    lastContact: "2026-08-20T21:05:00.000Z",
    categories: ["Recruiting"],
    companyName: "Northstar Labs",
    companyDomain: "northstarlabs.com",
    imageUrl: "/landing/people/tom-ellis.webp",
  },
  {
    id: "475214c1-4632-4963-b627-fcd83cac64de",
    name: "Jordan Kim",
    email: "jordan@meridiancloudhq.com",
    lastContact: "2026-08-12T20:02:00.000Z",
    categories: ["Recruiting"],
    companyName: "Meridian Cloud",
    companyDomain: "meridiancloudhq.com",
    imageUrl: "/landing/people/jordan-kim.webp",
  },
  {
    id: "91a92ca2-6dbc-489b-bc22-8f52e616b00e",
    name: "Eli Park",
    email: "eli@ready.app",
    lastContact: "2026-08-11T21:17:00.000Z",
    categories: ["Recruiting"],
    companyName: "Ready",
    companyDomain: "ready.app",
    imageUrl: "/landing/people/eli-park.webp",
  },
  {
    id: "c4e06ca5-d435-4703-9070-6f89936cd21f",
    name: "Nora Patel",
    email: "nora@ready.app",
    lastContact: "2026-08-11T21:17:00.000Z",
    categories: ["Recruiting"],
    companyName: "Ready",
    companyDomain: "ready.app",
    imageUrl: "/landing/people/nora-patel.webp",
  },
  {
    id: "f2c6ee74-ff51-41ed-9ae7-eb29d781b8e4",
    name: "Jussi Mäkinen",
    email: "jussi@ready.app",
    lastContact: "2026-08-05T18:37:00.000Z",
    categories: ["Recruiting"],
    companyName: "Ready",
    companyDomain: "ready.app",
    imageUrl: "/landing/people/jussi-makinen.webp",
  },
  {
    id: "4cfbebb5-b6c5-4044-95ac-6d2eaf5f01c5",
    name: "Maya Singh",
    email: "maya@ready.app",
    lastContact: "2026-08-03T15:52:00.000Z",
    categories: ["Recruiting"],
    companyName: "Ready",
    companyDomain: "ready.app",
    imageUrl: "/landing/people/maya-singh.webp",
  },
  {
    id: "d19712be-8b56-420e-90ce-ec72c8e2f947",
    name: "Omar Haddad",
    email: "omar@beaconhealthhq.com",
    lastContact: "2026-07-25T17:18:00.000Z",
    categories: ["Customers"],
    companyName: "Beacon Health",
    companyDomain: "beaconhealthhq.com",
    imageUrl: "/landing/people/omar-haddad.webp",
  },
  {
    id: "bee9cfd3-2d48-4986-9ffc-c7fcfd1661e7",
    name: "Nina Shah",
    email: "nina@meridiancloudhq.com",
    lastContact: "2026-07-25T15:52:00.000Z",
    categories: ["Sales"],
    companyName: "Meridian Cloud",
    companyDomain: "meridiancloudhq.com",
    imageUrl: "/landing/people/nina-shah.webp",
  },
  {
    id: "e9fb4d95-cf0b-4dc6-b804-9d54d1392899",
    name: "Iris Bennett",
    email: "iris@getformastudio.com",
    lastContact: "2026-07-24T23:00:00.000Z",
    categories: ["Recruiting"],
    companyName: "Forma Studio",
    companyDomain: "getformastudio.com",
    imageUrl: "/landing/people/iris-bennett.webp",
  },
  {
    id: "9ae3135c-08ec-498e-8fd0-a853eebb402d",
    name: "Joaquin Reyes",
    email: "joaquin@paperplaneteam.com",
    lastContact: "2026-07-21T23:27:00.000Z",
    categories: ["Recruiting"],
    companyName: "Paperplane",
    companyDomain: "paperplaneteam.com",
    imageUrl: "/landing/people/joaquin-reyes.webp",
  },
  {
    id: "110b713f-7c28-4023-9717-f372e16170e0",
    name: "Natalie Sun",
    email: "natalie@seabrighthq.com",
    lastContact: "2026-07-21T23:26:00.000Z",
    categories: ["Recruiting"],
    companyName: "Seabright",
    companyDomain: "seabrighthq.com",
    imageUrl: "/landing/people/natalie-sun.webp",
  },
  {
    id: "bcaa73c9-f04f-46fc-89b8-cb74f0528a92",
    name: "Kasper Sorensen",
    email: "kasper@mosaicworkshq.com",
    lastContact: "2026-07-17T23:25:00.000Z",
    categories: ["Recruiting"],
    companyName: "Mosaic Works",
    companyDomain: "mosaicworkshq.com",
    imageUrl: "/landing/people/kasper-sorensen.webp",
  },
  {
    id: "05105b19-9308-4c11-af94-cb73692edb0e",
    name: "Dalia Farah",
    email: "dalia@bridgewatertools.com",
    lastContact: "2026-07-17T23:24:00.000Z",
    categories: ["Recruiting"],
    companyName: "Bridgewater Tools",
    companyDomain: "bridgewatertools.com",
    imageUrl: "/landing/people/dalia-farah.webp",
  },
  {
    id: "4e16c5d8-438c-4ada-b1d2-b2bfd081ff17",
    name: "Cameron Nash",
    email: "cameron@tandemtravelhq.com",
    lastContact: "2026-07-17T23:23:00.000Z",
    categories: ["Recruiting"],
    companyName: "Tandem Travel",
    companyDomain: "tandemtravelhq.com",
    imageUrl: "/landing/people/cameron-nash.webp",
  },
  {
    id: "b64b378d-f947-4c3b-b671-83b8631b70c9",
    name: "Isabelle Marchand",
    email: "isabelle@willowenergyhq.com",
    lastContact: "2026-07-17T23:22:00.000Z",
    categories: ["Recruiting"],
    companyName: "Willow Energy",
    companyDomain: "willowenergyhq.com",
    imageUrl: "/landing/people/isabelle-marchand.webp",
  },
  {
    id: "8e1fb39f-e564-4845-94c5-cf2c7e480271",
    name: "Ashwin Reddy",
    email: "ashwin@parcelstudiohq.com",
    lastContact: "2026-07-15T23:21:00.000Z",
    categories: ["Recruiting"],
    companyName: "Parcel Studio",
    companyDomain: "parcelstudiohq.com",
    imageUrl: "/landing/people/ashwin-reddy.webp",
  },
];

export const DEMO_MOMENTS: DemoMoment[] = [
  {
    id: "danny-08",
    ts: "2026-09-04T15:40:00-07:00",
    kind: "meeting",
    title: "Danny flagged a tight timeline for the Bellagio project",
    description:
      "Danny described the scope as ambitious and the timeline as tight. Each specialist has a part to play in the plan.",
    boundedness: "event",
    category: "Partnerships",
    sources: ["zoom"],
    entities: {
      people: ["Danny Ocean", "Rusty Ryan", "Sam Zetterberg"],
      companies: ["Ocean & Co."],
    },
    interactionWith: ["Danny Ocean", "Rusty Ryan"],
    evidence: [
      {
        kind: "transcript",
        label: "Transcript · Danny flagged a tight timeline for the Bellagio project",
        snippet:
          "Danny Ocean: The scope is ambitious and the timeline is tight.\nDanny Ocean: But everyone has a part to play.",
      },
    ],
    state: "retained",
    meetingId: "danny-crew-timeline",
    durationMin: DEMO_DURATION_MIN_45,
  },
  {
    id: "danny-07",
    ts: "2026-09-04T15:24:00-07:00",
    kind: "meeting",
    title: "Danny confirmed Reuben will fund the project",
    description:
      "When you asked who was covering the budget, Danny named Reuben and said he had agreed. The funding confirmation came from Danny.",
    boundedness: "event",
    category: "Partnerships",
    sources: ["zoom"],
    entities: {
      people: ["Danny Ocean", "Sam Zetterberg"],
      companies: ["Ocean & Co."],
    },
    interactionWith: ["Danny Ocean"],
    evidence: [
      {
        kind: "transcript",
        label: "Transcript · Danny confirmed Reuben will fund the project",
        snippet: "Sam Zetterberg: Who is covering the budget?\nDanny Ocean: Reuben. He’s in.",
      },
    ],
    state: "retained",
    meetingId: "danny-crew-timeline",
    durationMin: DEMO_DURATION_MIN_45,
  },
  {
    id: "danny-06",
    ts: "2026-09-04T15:05:00-07:00",
    kind: "meeting",
    title: "You agreed to review security with Livingston before the walkthrough",
    description:
      "Livingston has the security requirements. Danny asked you to review them together, and you agreed to arrange it before the next meeting.",
    boundedness: "event",
    category: "Partnerships",
    sources: ["zoom"],
    entities: {
      people: ["Danny Ocean", "Sam Zetterberg"],
      companies: ["Ocean & Co."],
    },
    interactionWith: ["Danny Ocean"],
    evidence: [
      {
        kind: "transcript",
        label: "Transcript · You agreed to review security with Livingston before the walkthrough",
        snippet:
          "Danny Ocean: Livingston has the security requirements. Can you go through them with him?\nSam Zetterberg: I’ll set that up before we meet.",
      },
    ],
    state: "retained",
    meetingId: "danny-crew-timeline",
    durationMin: DEMO_DURATION_MIN_45,
  },
  {
    id: "danny-05",
    ts: "2026-09-03T09:10:00-07:00",
    kind: "email_sent",
    title: "Danny prefers to discuss the plan in person, not over email",
    description:
      "You asked for a written plan. Danny preferred an in-person walkthrough, and you agreed to meet that week.",
    boundedness: "event",
    category: "Partnerships",
    sources: ["gmail"],
    entities: {
      people: ["Danny Ocean", "Sam Zetterberg"],
      companies: ["Ocean & Co."],
    },
    interactionWith: ["Danny Ocean"],
    evidence: [],
    state: "retained",
  },
  {
    id: "danny-04",
    ts: "2026-09-02T13:05:00-07:00",
    kind: "meeting",
    title: "Danny’s plan depends on three launches happening the same night",
    description:
      "You questioned whether three simultaneous launches were realistic. Danny confirmed the timing was intentional and central to the plan.",
    boundedness: "event",
    category: "Partnerships",
    sources: ["zoom"],
    entities: {
      people: ["Danny Ocean", "Sam Zetterberg"],
      companies: ["Ocean & Co."],
    },
    interactionWith: ["Danny Ocean"],
    evidence: [
      {
        kind: "transcript",
        label: "Transcript · Danny’s plan depends on three launches happening the same night",
        snippet:
          "Sam Zetterberg: Three launches on the same night? Is that realistic?\nDanny Ocean: That’s the whole idea.",
      },
    ],
    state: "retained",
    meetingId: "danny-intro-lunch",
    durationMin: DEMO_DURATION_MIN_45,
  },
  {
    id: "danny-03",
    ts: "2026-09-02T12:52:00-07:00",
    kind: "meeting",
    title: "Rusty is your contact for coordinating with Danny",
    description:
      "Rusty offered to handle questions and coordination between you and Danny. He prefers to discuss plans in person over a meal.",
    boundedness: "event",
    category: "Partnerships",
    sources: ["zoom"],
    entities: {
      people: ["Rusty Ryan", "Danny Ocean", "Sam Zetterberg"],
      companies: ["Ocean & Co."],
    },
    interactionWith: ["Rusty Ryan", "Danny Ocean"],
    evidence: [
      {
        kind: "transcript",
        label: "Transcript · Rusty is your contact for coordinating with Danny",
        snippet:
          "Rusty Ryan: Anything you need, you come to me.\nRusty Ryan: And we do these over food. It keeps everyone honest.",
      },
    ],
    state: "retained",
    meetingId: "danny-intro-lunch",
    durationMin: DEMO_DURATION_MIN_45,
  },
  {
    id: "danny-02",
    ts: "2026-09-02T12:30:00-07:00",
    kind: "meeting",
    title: "Danny needs eleven specialists for the Bellagio project",
    description:
      "Danny described a crew of eleven, each with a distinct role. He invited you to hear the full plan before committing to a part.",
    boundedness: "event",
    category: "Partnerships",
    sources: ["zoom"],
    entities: {
      people: ["Danny Ocean", "Rusty Ryan", "Sam Zetterberg"],
      companies: ["Ocean & Co."],
    },
    interactionWith: ["Danny Ocean", "Rusty Ryan"],
    evidence: [
      {
        kind: "transcript",
        label: "Transcript · Danny needs eleven specialists for the Bellagio project",
        snippet:
          "Danny Ocean: I need eleven people, and every one of them has a part to play.\nSam Zetterberg: What would mine be?\nDanny Ocean: That’s what the next conversation is for.",
      },
    ],
    state: "retained",
    meetingId: "danny-intro-lunch",
    durationMin: DEMO_DURATION_MIN_45,
  },
  {
    id: "danny-01",
    ts: "2026-08-31T16:20:00-07:00",
    kind: "email_received",
    title: "Rusty introduced you to Danny for the Bellagio project",
    description:
      "Rusty said Danny was assembling a crew and wanted you in the first conversation. He suggested an introduction over a meal.",
    boundedness: "event",
    category: "Partnerships",
    sources: ["gmail"],
    entities: {
      people: ["Rusty Ryan", "Sam Zetterberg"],
      companies: ["Ocean & Co."],
    },
    interactionWith: ["Rusty Ryan"],
    evidence: [],
    state: "retained",
  },
  {
    id: "m-194",
    ts: "2026-08-28T10:18:00-07:00",
    kind: "meeting",
    boundedness: "event",
    title: "Meridian’s rollout is waiting on customer data validation",
    description:
      "Sophie said the rollout can move forward once customer data has been validated. This is an outstanding condition for launch.",
    category: "Projects",
    entities: {
      people: ["Sophie Chen"],
      roles: ["COO"],
      companies: ["Meridian"],
    },
    evidence: [
      {
        kind: "transcript",
        label: "Meridian rollout conversation",
        snippet: "Sophie Chen: The rollout can move forward once customer data is validated",
      },
    ],
    state: "fading",
    sources: ["zoom"],
    interactionWith: ["Sophie Chen"],
    fadesOn: "2028-08-28",
    meetingId: "zoom-m-172",
  },
  {
    id: "m-193",
    ts: "2026-08-28T09:34:00-07:00",
    kind: "meeting",
    boundedness: "event",
    title: "Sophie confirmed Meridian’s pricing still needs approval",
    description:
      "Final pricing approval remains outstanding. Sophie has not confirmed that pricing is ready for the rollout.",
    category: "Projects",
    entities: {
      people: ["Sophie Chen"],
      roles: ["COO"],
      companies: ["Meridian"],
    },
    evidence: [
      {
        kind: "transcript",
        label: "Meridian rollout conversation",
        snippet: "Sophie Chen: Pricing still needs final approval",
      },
    ],
    state: "fading",
    sources: ["zoom"],
    interactionWith: ["Sophie Chen"],
    fadesOn: "2028-08-28",
    meetingId: "zoom-m-172",
  },
  {
    id: "m-192",
    ts: "2026-08-28T09:12:00-07:00",
    kind: "meeting",
    boundedness: "event",
    title: "You still owe Sophie an updated forecast",
    description:
      "The updated forecast remains your follow-up for Sophie. No delivery date was recorded in this conversation.",
    category: "Projects",
    entities: {
      people: ["Sophie Chen"],
      roles: ["COO"],
      companies: ["Meridian"],
    },
    evidence: [
      {
        kind: "transcript",
        label: "Meridian rollout conversation",
        snippet: "Sophie Chen: You owe Sophie the updated forecast",
      },
    ],
    state: "fading",
    sources: ["zoom"],
    interactionWith: ["Sophie Chen"],
    fadesOn: "2028-08-28",
    meetingId: "zoom-m-172",
  },
  {
    id: "m-195",
    ts: "2026-08-28T08:45:00-07:00",
    kind: "email_sent",
    boundedness: "event",
    title: "Nia’s follow-up will focus on one project, with no take-home work",
    description:
      "You requested a 30-minute discussion of a user problem, Nia’s decisions, and the result. She does not need to prepare a new deck or complete an assignment. You are waiting for her availability.",
    category: "Recruiting",
    entities: {
      people: ["Nia Brooks"],
      roles: ["Design Lead"],
    },
    interactionWith: ["Nia Brooks"],
    evidence: [],
    state: "fading",
    sources: ["gmail", "ashby"],
    fadesOn: "2028-08-28",
  },
  {
    id: "m-177",
    ts: "2026-08-28T08:12:00-07:00",
    kind: "meeting",
    boundedness: "event",
    title: "Meridian still has two key roles to fill",
    description:
      "Sophie identified two open hires as outstanding work for Meridian. Neither hire was confirmed as filled.",
    entities: {
      people: ["Sophie Chen"],
      roles: ["COO"],
      companies: ["Meridian"],
    },
    evidence: [
      {
        kind: "transcript",
        label: "Meridian rollout conversation",
        snippet: "Sophie Chen: Two key hires are still open",
      },
    ],
    sources: ["zoom"],
    state: "fading",
    fadesOn: "2028-08-28",
    category: "Projects",
    interactionWith: ["Sophie Chen"],
    meetingId: "zoom-m-172",
  },
  {
    id: "m-180",
    ts: "2026-08-27T17:46:00-07:00",
    kind: "meeting",
    boundedness: "event",
    title: "Meridian’s European expansion has moved to Q1",
    description: "Sophie said European expansion is now planned for Q1, replacing the earlier timing.",
    entities: {
      people: ["Sophie Chen"],
      roles: ["COO"],
      companies: ["Meridian"],
    },
    evidence: [
      {
        kind: "transcript",
        label: "Meridian rollout conversation",
        snippet: "Sophie Chen: Europe expansion is now pushed to Q1",
      },
    ],
    state: "fading",
    sources: ["zoom"],
    interactionWith: ["Sophie Chen"],
    fadesOn: "2028-08-28",
    category: "Projects",
    meetingId: "zoom-m-152",
  },
  {
    id: "m-179",
    meetingId: "nia-design-debrief",
    durationMin: DEMO_DURATION_MIN_35,
    ts: "2026-08-27T16:32:00-07:00",
    kind: "meeting",
    boundedness: "event",
    title: "You and Sergei want evidence of Nia’s impact before deciding",
    description:
      "The panel agreed on a focused, 30-minute follow-up about one project: the user problem, Nia’s decisions, and the outcome. You will send the questions and arrange the conversation.",
    entities: {
      people: ["Nia Brooks", "Sergei Volkov"],
      roles: ["Design Lead"],
    },
    evidence: [
      {
        kind: "transcript",
        label: "Transcript · You and Sergei want evidence of Nia’s impact before deciding",
        snippet:
          "Sergei Volkov: Nia is good at keeping designs consistent across teams. What do we still need before making a decision?\nNina Patel: One clear example of how her work helped users. What problem did she solve, what did she change, and what got better?",
      },
    ],
    sources: ["zoom", "ashby"],
    interactionWith: ["Sergei Volkov"],
    state: "fading",
    fadesOn: "2028-08-27",
  },
  {
    id: "m-178",
    ts: "2026-08-27T15:16:00-07:00",
    kind: "email_sent",
    boundedness: "event",
    title: "Tomas’s final review will cover capacity, ownership, and mentoring",
    description:
      "You told Tomas the team wanted to continue and sent the remaining topics. You are waiting for his availability to schedule the final review.",
    entities: {
      roles: ["Senior Backend"],
      people: ["Tomas Vane", "Marcus Lee", "Elena"],
    },
    evidence: [],
    durationMin: DEMO_DURATION_MIN_28,
    sources: ["gmail", "ashby"],
    interactionWith: ["Tomas Vane"],
    state: "fading",
    fadesOn: "2028-08-27",
  },
  {
    id: "m-197",
    ts: "2026-08-27T14:30:00-07:00",
    kind: "email_sent",
    boundedness: "event",
    title: "Leo is waiting for a decision while other interviews finish",
    description:
      "You told Leo there was no next round to schedule yet and promised an update once the team had a decision. You also thanked him for arranging his reference.",
    category: "Recruiting",
    entities: {
      people: ["Leo Chen"],
      roles: ["Senior Backend"],
    },
    interactionWith: ["Leo Chen"],
    evidence: [],
    state: "fading",
    sources: ["gmail", "ashby"],
    fadesOn: "2028-08-27",
  },
  {
    id: "m-196",
    ts: "2026-08-27T14:10:00-07:00",
    kind: "thread",
    boundedness: "event",
    title: "Sergei will check Dana’s $275k salary target against the approved range",
    description:
      "You asked Sergei to check the salary range before you respond to Dana. Neither of you has committed to her requested base salary.",
    category: "Recruiting",
    entities: {
      people: ["Sergei Volkov", "Dana Okafor"],
      roles: ["Design Lead"],
    },
    interactionWith: ["Sergei Volkov"],
    evidence: [],
    state: "fading",
    sources: ["slack", "ashby"],
    fadesOn: "2028-08-27",
  },
  {
    id: "m-176",
    ts: "2026-08-27T12:47:00-07:00",
    kind: "meeting",
    boundedness: "event",
    title: "Dana is looking for a $275k base salary",
    description:
      "Dana shared her target in the compensation call. You agreed to check the approved range with Sergei before returning with a package.",
    entities: {
      people: ["Dana Okafor", "Sergei Volkov"],
      roles: ["Design Lead"],
    },
    evidence: [
      {
        kind: "transcript",
        label: "Transcript · Dana is looking for a $275k base salary",
        snippet: "Sam Zetterberg: What base would make the move work?\nDana Okafor: $275k is my ask.",
      },
    ],
    note: "That is Dana’s ask, not a salary I have promised.",
    sources: ["zoom", "ashby"],
    interactionWith: ["Dana Okafor"],
    meetingId: "zoom-m-176",
    state: "fading",
    fadesOn: "2028-08-27",
  },
  {
    id: "m-175",
    ts: "2026-08-27T11:11:00-07:00",
    kind: "thread",
    boundedness: "event",
    title: "Leo’s next round is on hold until the team finishes with Tomas",
    description:
      "You agreed with Marcus and Elena to keep Leo in consideration while prioritizing Tomas’s remaining interviews. You will give Leo an honest update on timing.",
    entities: {
      people: ["Leo Chen", "Marcus Lee", "Elena"],
      roles: ["Senior Backend"],
    },
    evidence: [],
    sources: ["slack"],
    interactionWith: ["Marcus Lee", "Elena"],
    state: "fading",
    fadesOn: "2028-08-28",
  },
  {
    id: "m-174",
    ts: "2026-08-27T10:18:00-07:00",
    kind: "email_sent",
    boundedness: "event",
    title: "Anna’s first Design Lead conversation is awaiting confirmation",
    description: "You proposed August 31 for a recruiter screen. Anna has not yet confirmed a time.",
    entities: {
      people: ["Anna Kowalski"],
      roles: ["Design Lead"],
    },
    evidence: [],
    sources: ["gmail"],
    interactionWith: ["Anna Kowalski"],
    state: "fading",
    fadesOn: "2028-08-27",
  },
  {
    id: "m-173",
    ts: "2026-08-27T09:24:00-07:00",
    kind: "sourcing_session",
    boundedness: "session",
    title: "Anna’s product-system work stood out in the Design Lead search",
    description:
      "You saved Anna’s profile because of her product-system work and decided to invite her to an initial conversation.",
    entities: {
      people: ["Anna Kowalski"],
      roles: ["Design Lead"],
    },
    evidence: [],
    durationMin: DEMO_DURATION_MIN_27,
    sources: ["linkedin", "ashby"],
    state: "fading",
    fadesOn: "2028-08-27",
  },
  {
    id: "m-172",
    ts: "2026-08-27T08:36:00-07:00",
    kind: "meeting",
    boundedness: "event",
    title: "You reviewed Meridian’s rollout with Sophie",
    description: SOPHIE_SUMMARY,
    entities: {
      people: ["Sophie Chen"],
      roles: ["COO"],
      companies: ["Meridian"],
    },
    evidence: [
      {
        kind: "transcript",
        label: "Meridian rollout conversation",
        snippet:
          "Sophie Chen: We’re working closely on Meridian’s rollout and next phase of growth. Pricing, hiring, and expansion are still active topics, and we need to resolve the remaining decisions to get the rollout over the line.",
      },
    ],
    sources: ["zoom"],
    interactionWith: ["Sophie Chen"],
    meetingId: "zoom-m-172",
    state: "fading",
    fadesOn: "2028-08-28",
    category: "Projects",
  },
  {
    id: "m-171",
    ts: "2026-08-26T17:46:00-07:00",
    kind: "email_sent",
    boundedness: "event",
    title: "Dana’s references are complete; compensation is the next conversation",
    description: "You proposed an August 27 call to discuss Dana’s expectations and the available package.",
    entities: {
      people: ["Dana Okafor", "Sergei Volkov"],
      roles: ["Design Lead"],
    },
    evidence: [],
    sources: ["gmail"],
    interactionWith: ["Dana Okafor"],
    state: "fading",
    fadesOn: "2028-08-27",
  },
  {
    id: "m-170",
    ts: "2026-08-26T16:32:00-07:00",
    kind: "meeting",
    boundedness: "event",
    title: "Marta confirmed Leo’s coaching led to lasting incident-lead roles",
    description:
      "All three engineers continued into permanent command rotations. Marta confirmed this when you followed up on whether their responsibilities had lasted.",
    entities: {
      people: ["Leo Chen", "Marcus Lee", "Marta Silva"],
      roles: ["Senior Backend"],
    },
    evidence: [
      {
        kind: "transcript",
        label: "Transcript · Marta confirmed Leo’s coaching led to lasting incident-lead roles",
        snippet:
          "Sam Zetterberg: Did those three engineers keep leading incidents after Leo’s coaching?\nMarta Silva: Yes, all three later joined permanent incident-command rotations.",
      },
    ],
    sources: ["zoom", "ashby"],
    interactionWith: ["Marta Silva"],
    meetingId: "zoom-m-170",
    state: "fading",
    fadesOn: "2028-08-26",
  },
  {
    id: "m-168",
    ts: "2026-08-26T14:05:00-07:00",
    kind: "stage_change",
    boundedness: "event",
    title: "Elena recommends Tomas for final review",
    description:
      "Elena’s technical recommendation is positive. Capacity and ownership remain the topics to resolve in the final conversation.",
    entities: {
      people: ["Elena", "Tomas Vane"],
      roles: ["Senior Backend"],
    },
    evidence: [],
    sources: ["ashby"],
    state: "fading",
    fadesOn: "2028-08-28",
  },
  {
    id: "m-167",
    ts: "2026-08-26T12:47:00-07:00",
    kind: "meeting",
    boundedness: "event",
    title: "Final pricing approval remains open for Meridian",
    description:
      "You and Sophie discussed the outstanding approval. The conversation did not establish that pricing had been signed off.",
    entities: {
      people: ["Sophie Chen"],
      roles: ["COO"],
      companies: ["Meridian"],
    },
    evidence: [
      {
        kind: "transcript",
        label: "Meridian rollout conversation",
        snippet: "Sophie Chen: Pricing still needs final approval",
      },
    ],
    sources: ["zoom"],
    interactionWith: ["Sophie Chen"],
    meetingId: "zoom-m-167",
    state: "fading",
    fadesOn: "2028-08-28",
    category: "Projects",
  },
  {
    id: "m-166",
    ts: "2026-08-26T11:11:00-07:00",
    kind: "thread",
    boundedness: "event",
    title: "Sergei supports a compensation discussion with Dana",
    description:
      "Two positive references supported moving forward. You agreed to arrange the conversation before making any commitment to a package.",
    entities: {
      people: ["Dana Okafor", "Sergei Volkov"],
      roles: ["Design Lead"],
    },
    evidence: [],
    sources: ["slack"],
    interactionWith: ["Sergei Volkov"],
    state: "fading",
    fadesOn: "2028-08-27",
  },
  {
    id: "m-163",
    ts: "2026-08-26T08:36:00-07:00",
    kind: "meeting",
    boundedness: "event",
    title: "Tomas still needs to explain his multi-region capacity estimate",
    description:
      "Elena considers Tomas’s recovery approach strong. The remaining technical question is how he estimated capacity across regions.",
    entities: {
      people: ["Elena", "Marcus Lee", "Tomas Vane"],
      roles: ["Senior Backend"],
    },
    evidence: [
      {
        kind: "transcript",
        label: "Transcript · Tomas still needs to explain his multi-region capacity estimate",
        snippet: "Sam Zetterberg: What is still unresolved for Tomas?\nElena: One multi-region capacity estimate.",
      },
    ],
    sources: ["zoom", "ashby"],
    interactionWith: ["Elena"],
    meetingId: "zoom-m-163",
    state: "fading",
    fadesOn: "2028-08-28",
  },
  {
    id: "m-181",
    ts: "2026-08-26T08:12:00-07:00",
    kind: "email_received",
    boundedness: "event",
    title: "Northstar needs to close a 12% adoption gap before October renewal",
    description:
      "Maya identified adoption as a condition for renewal. You agreed to focus the next account check-in on progress toward closing that gap.",
    category: "Customer Success",
    entities: {
      people: ["Maya Torres"],
      roles: ["Customer"],
      companies: ["Northstar Labs"],
    },
    evidence: [],
    state: "fading",
    durationMin: DEMO_DURATION_MIN_31,
    sources: ["gmail", "notion"],
    interactionWith: ["Maya Torres"],
    fadesOn: "2028-08-26",
  },
];

export const DEMO_MEETINGS: CandidateInterview[] = [
  {
    id: "maya-sam-one-on-one",
    title: "Maya : Sam",
    time: "Sep 4",
    preview: "A strong week, a clear next project, and more room for focused design work.",
    date: "Sep 4, 5:00 PM",
    sensitiveReviewId: "review-maya-sam-health",
    participants: [
      {
        name: "Maya Lin",
        initials: "SC",
        color: "#866fcb",
      },
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "The permissions redesign landed well in testing, and Maya will lead the first design pass on team invitations.",
          "Sam will protect time for Maya’s project work by batching small design requests and taking over a status update.",
        ],
      },
      {
        heading: "Permissions redesign",
        bullets: [
          "All five usability participants completed permissions setup without help. Maya credits the simpler role labels and the access preview.",
          "Sam praised bringing engineering in early and using research to keep the scope small.",
        ],
      },
      {
        heading: "Team invitations",
        bullets: [
          "Maya owns the problem definition and design review for helping an admin bring teammates into the right workspace without support.",
          "It doubles as her practice leading a project from the first customer conversation through launch.",
        ],
      },
      {
        heading: "Focus time",
        bullets: [
          "Small review requests will be collected in one place and handled in two scheduled sessions a week.",
          "Tuesday and Thursday mornings stay protected for project work; Sam takes the cross-team status update for two weeks.",
        ],
      },
      {
        heading: "Next steps",
        bullets: [
          "Maya will share the permissions before-and-after at the next team review.",
          "Sam will arrange three short customer conversations for the invitation work.",
          "Maya will bring two rough invitation approaches to a review with Sam and engineering next Thursday.",
        ],
      },
    ],
    tasks: [
      {
        title: "Share the permissions redesign at team review",
        description: "Bring the before-and-after flow and the five usability-session outcomes.",
        owner: "Maya Lin",
        initials: "SC",
        color: "#866fcb",
      },
      {
        title: "Arrange three customer conversations",
        description: "Connect Maya with admins who recently invited teammates into a workspace.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        title: "Explore two team-invitation approaches",
        description: "Use the customer conversations to prepare rough options for next Thursday’s design review.",
        owner: "Maya Lin",
        initials: "SC",
        color: "#866fcb",
      },
    ],
    startedAt: "2026-09-04T17:00:00-07:00",
    company: "Highlight",
    category: "Customer Success",
  },
  {
    id: "website-launch-readiness",
    title: "Website · Final launch checks",
    startedAt: "2026-09-04T16:30:00-07:00",
    company: "Highlight",
    category: "Customer Success",
    notes: [
      {
        heading: "Overview",
        bullets: [
          "The home and pricing pages are approved. Two checks stand between the team and a Friday launch: mobile signup and pricing.",
          "There is no go-ahead yet. Sam approves the launch once both checks pass.",
        ],
      },
      {
        heading: "Mobile signup",
        bullets: [
          "Desktop signup works. On phones the signup button sometimes does not respond, which is the only bug left from Marcus’s checks.",
        ],
      },
      {
        heading: "Pricing",
        bullets: [
          "Nina still needs to compare the monthly and annual prices on the new page with billing. Visual approval of the page does not replace this check.",
        ],
      },
      {
        heading: "Decisions",
        bullets: ["The launch target stays Friday, Sep 11, provided both checks pass."],
      },
      {
        heading: "Next steps",
        bullets: [
          "Marcus will fix mobile signup and retest on phones before Monday’s check-in.",
          "Nina will confirm the displayed prices match billing.",
          "Sam will get both results before the Sep 7 check-in and give the go-ahead once they pass.",
        ],
      },
    ],
    endedAt: "2026-09-04T23:50:00.000Z",
    time: "Sep 4",
    date: "Sep 4, 4:30 PM",
    preview:
      "The home and pricing pages are approved. Sam, Marcus, and Nina checked the two items still open after the day’s email and Slack updates: mobile signup and pricing.",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Marcus Lee",
        initials: "ML",
        color: "#5b7f9e",
      },
      {
        name: "Nina Patel",
        initials: "NP",
        color: "#5b7f9e",
      },
    ],
    tasks: [
      {
        id: "mine-website-signup",
        title: "Check the mobile signup fix with Marcus",
        description: "Ask for the test result and confirm whether anything still blocks the website launch.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        id: "mine-website-pricing",
        title: "Confirm the final pricing-page check",
        description: "Follow up on the launch email and make sure the approved prices are the ones going live.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
    ],
  },
  {
    id: "danny-crew-timeline",
    startedAt: "2026-09-04T15:00:00-07:00",
    endedAt: "2026-09-04T15:45:00-07:00",
    title: "Danny · Crew and timeline",
    time: "3:00 PM",
    date: "Sep 4, 3:00 PM",
    category: "Partnerships",
    preview:
      "Danny walked through the crew and the timeline. Security requirements go to Livingston; the budget depends on Reuben.",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Danny Ocean",
        initials: "DO",
        color: "#5b7f9e",
      },
      {
        name: "Rusty Ryan",
        initials: "RR",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Danny walked Sam through how the eleven specialists split the work and why the three launches have to happen on the same night.",
          "The scope is ambitious and the timeline tight, but every role is defined. Sam still has not seen the full plan.",
        ],
      },
      {
        heading: "Roles and timing",
        bullets: [
          "Each specialist owns one part, and the parts only work if they run in sequence on the same night.",
          "Rusty coordinates between the specialists and stays Sam’s point of contact.",
        ],
      },
      {
        heading: "Budget",
        bullets: [
          "Reuben is funding the project. Danny says Reuben has agreed; the amount and what it covers were not discussed.",
        ],
      },
      {
        heading: "Security",
        bullets: [
          "Livingston holds the security requirements. Danny asked Sam to review them before committing to a part.",
        ],
      },
      {
        heading: "Decisions",
        bullets: ["Danny will share the full plan in person rather than in writing."],
      },
      {
        heading: "Next steps",
        bullets: [
          "Sam will review the security requirements with Livingston before the walkthrough.",
          "Danny will walk Sam through the full plan in person.",
        ],
      },
    ],
    tasks: [
      {
        id: "danny-task-livingston",
        title: "Review the security requirements with Livingston",
        description: "Go through the requirements before the plan walkthrough so the crew can plan around them.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        id: "danny-task-walkthrough",
        title: "Walk Sam through the full plan",
        description: "Keep it in person. Danny prefers not to put the plan in email.",
        owner: "Danny Ocean",
        initials: "DO",
        color: "#8c7761",
      },
    ],
  },
  {
    id: "website-kickoff",
    title: "Website launch planning",
    startedAt: "2026-09-03T10:00:00-07:00",
    company: "Highlight",
    category: "Customer Success",
    notes: [
      {
        heading: "Overview",
        bullets: [
          "The team set Friday, Sep 11 as the target for launching the new website.",
          "Sam gives the final go-ahead once testing and the pricing check are complete.",
        ],
      },
      {
        heading: "Pages",
        bullets: ["Maya is finishing the home and pricing pages and will send them for approval."],
      },
      {
        heading: "Launch checks",
        bullets: [
          "Marcus will test signup on desktop and phones before launch.",
          "Nina will make sure the prices on the site match the billing system.",
        ],
      },
      {
        heading: "Decisions",
        bullets: ["Launch target: Friday, Sep 11, dependent on testing and pricing passing."],
      },
      {
        heading: "Next steps",
        bullets: [
          "Maya will send the home and pricing pages for approval.",
          "Marcus will test signup on desktop and phones.",
          "Nina will compare the displayed prices with billing.",
          "The team meets again on Monday, Sep 7 to review what is ready.",
        ],
      },
    ],
    endedAt: "2026-09-03T17:30:00.000Z",
    time: "Sep 3",
    date: "Sep 3, 10:00 AM",
    preview:
      "The team is aiming to launch the new website on Friday, September 11. Sam will give the final go-ahead once testing and the pricing check are complete.",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Maya Lin",
        initials: "SC",
        color: "#5b7f9e",
      },
      {
        name: "Marcus Lee",
        initials: "ML",
        color: "#5b7f9e",
      },
      {
        name: "Nina Patel",
        initials: "NP",
        color: "#5b7f9e",
      },
    ],
    tasks: [],
  },
  {
    id: "danny-intro-lunch",
    startedAt: "2026-09-02T12:30:00-07:00",
    endedAt: "2026-09-02T13:15:00-07:00",
    title: "Danny · Intro over lunch",
    time: "12:30 PM",
    date: "Sep 2, 12:30 PM",
    category: "Partnerships",
    preview: "Danny described a project that needs eleven specialists. Rusty will coordinate.",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Danny Ocean",
        initials: "DO",
        color: "#5b7f9e",
      },
      {
        name: "Rusty Ryan",
        initials: "RR",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Rusty introduced Sam to Danny, who is assembling eleven specialists for a project at the Bellagio and wants Sam to take one of the parts.",
          "Danny kept the details light. The full plan comes in a follow-up conversation.",
        ],
      },
      {
        heading: "The crew",
        bullets: [
          "Every specialist has one defined part to play. Danny has not said which part he has in mind for Sam.",
          "Rusty will be Sam’s point of contact and wants planning conversations to happen in person, over a meal.",
        ],
      },
      {
        heading: "Timing",
        bullets: [
          "Sam questioned running three launches on the same night. Danny said the timing is the whole idea and the plan depends on it.",
        ],
      },
      {
        heading: "Next steps",
        bullets: [
          "Rusty will set up the next conversation over food.",
          "Danny will share the full plan in person; he prefers to keep it off email.",
        ],
      },
    ],
    tasks: [
      {
        id: "danny-task-rusty",
        title: "Set up the next conversation over food",
        description: "Find a time this week for Sam, Danny, and Rusty.",
        owner: "Rusty Ryan",
        initials: "RR",
        color: "#6d8f68",
      },
    ],
  },
  {
    id: "hiring-next-steps",
    title: "Hiring · Next steps and open decisions",
    startedAt: "2026-08-28T10:30:00-07:00",
    company: "Highlight",
    category: "Recruiting",
    notes: [
      {
        heading: "Overview",
        bullets: [
          "The team reviewed where each open candidate stands and what they are waiting on. No new hiring decisions were made.",
          "Sam coordinates every follow-up and will send one update with an owner for each open decision.",
        ],
      },
      {
        heading: "Tomas and Leo",
        bullets: [
          "Tomas’s final review still needs the multi-region capacity estimate.",
          "Leo’s next round stays paused until Marcus and Elena confirm the timing.",
        ],
      },
      {
        heading: "Design candidates",
        bullets: [
          "Dana is waiting on the salary-range check with Sergei. Nia needs a focused project follow-up.",
          "Anna’s first conversation is booked; the questions should focus on the work she personally led.",
        ],
      },
      {
        heading: "Decisions",
        bullets: [
          "Keep new backend interviews paused while the current rounds finish, and keep the backup list current.",
        ],
      },
      {
        heading: "Next steps",
        bullets: [
          "Sam will collect the outstanding scorecards and draft the weekly hiring update.",
          "Sam will check with Marcus and Elena when Leo’s process can resume.",
          "Sam will prepare questions for the first conversation with Anna.",
        ],
      },
    ],
    endedAt: "2026-08-28T18:00:00.000Z",
    time: "Aug 28",
    date: "Aug 28, 10:30 AM",
    preview:
      "The team checked what each candidate is waiting for and agreed on the follow-ups Sam will coordinate. No new hiring decisions were made.",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Marcus Lee",
        initials: "ML",
        color: "#5b7f9e",
      },
      {
        name: "Elena",
        initials: "E",
        color: "#5b7f9e",
      },
      {
        name: "Sergei Volkov",
        initials: "SV",
        color: "#5b7f9e",
      },
    ],
    tasks: [
      {
        id: "mine-anna-intro",
        title: "Prepare for the first conversation with Anna",
        description:
          "Review her product-system work and write down two questions about the projects she personally led.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        id: "mine-leo-timing",
        title: "Check when Leo’s hiring process can resume",
        description:
          "Get a timing update from Marcus and Elena before following up with Leo. The next round is still paused.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        id: "mine-interview-scorecards",
        title: "Collect the remaining interview scorecards",
        description: "Ask interviewers to record concrete examples before the next hiring discussion.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        id: "mine-backend-backups",
        title: "Review the backend candidate backups",
        description:
          "Keep the shortlist current while the existing candidates finish their rounds; new interviews are paused.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        id: "mine-weekly-update",
        title: "Draft the weekly hiring update",
        description: "Summarize the open decisions for Tomas, Dana, Nia, and Leo, with an owner for each next step.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
    ],
  },
  {
    id: "noah-williams",
    startedAt: "2026-08-28T09:00:00-07:00",
    title: "Noah · Platform engineering interview",
    time: "Aug 28",
    preview: "Strong reliability experience; next, test architecture choices and product collaboration.",
    date: "Aug 28, 9:00 AM",
    participants: [
      {
        name: "Noah Williams",
        initials: "NW",
        color: "#6d8f68",
      },
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Jon Bell",
        initials: "JB",
        color: "#b47755",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Noah walked Sam and Jon through a multi-region event pipeline he led, focused on making failures easier to recover from.",
          "Strong technical judgment. The open question is how he handles a design problem when product requirements are incomplete.",
        ],
      },
      {
        heading: "Reliability approach",
        bullets: [
          "He starts with clear limits, safe retries, and simple recovery steps before adding more infrastructure.",
          "The changes reduced his team’s on-call workload.",
        ],
      },
      {
        heading: "Working with engineers",
        bullets: ["His examples showed him helping other engineers make decisions, not only making them himself."],
      },
      {
        heading: "Decisions",
        bullets: [
          "Move Noah to the architecture round. This is an invitation to the next stage, not a hiring decision.",
        ],
      },
      {
        heading: "Next steps",
        bullets: [
          "Jon will send the architecture brief, including the constraints and a note that no advance implementation is expected.",
          "Sam will book the product partnership interview after the architecture round.",
        ],
      },
    ],
    tasks: [
      {
        title: "Send Noah the architecture interview brief",
        description: "Include the system constraints and clarify that no advance implementation is expected.",
        owner: "Jon Bell",
        initials: "JB",
        color: "#b47755",
      },
      {
        title: "Book the product partnership interview",
        description: "Find a 45-minute slot with the platform product lead after the technical round.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
    ],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "beacon-rollout-readiness",
    title: "Beacon · Rollout readiness",
    startedAt: "2026-08-27T18:15:00-07:00",
    company: "Beacon Health",
    category: "Customer Success",
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Beacon’s 240-seat rollout is waiting on the security training Omar asked for on Jul 25. Sam and Omar agreed to run it before opening wider access.",
        ],
      },
      {
        heading: "Security training",
        bullets: [
          "The session covers access permissions, what information is captured, and how rollout controls work.",
          "Omar will choose which members of his security team attend.",
        ],
      },
      {
        heading: "Rollout timing",
        bullets: [
          "No activation date was promised. The date is set only after the security team completes the session.",
        ],
      },
      {
        heading: "Decisions",
        bullets: ["Train Beacon’s security team before enabling the remaining seats."],
      },
      {
        heading: "Next steps",
        bullets: [
          "Sam will send Omar two training times and prepare the agenda.",
          "Omar will confirm the attendees once the times are in.",
        ],
      },
    ],
    endedAt: "2026-08-28T01:35:00.000Z",
    time: "Aug 27",
    date: "Aug 27, 6:15 PM",
    preview:
      "Sam and Omar revisited the security training requested in their July 25 call. Beacon’s 240-seat rollout is still waiting on that session.",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Omar Haddad",
        initials: "OH",
        color: "#5b7f9e",
      },
    ],
    tasks: [
      {
        id: "mine-beacon-training",
        title: "Book security training with Omar",
        description:
          "Beacon’s 240-seat rollout is waiting on this session. Send Omar two times and confirm who should attend.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        id: "mine-beacon-attendees",
        title: "Prepare Beacon’s security-training agenda",
        description:
          "Cover access, captured information, and rollout controls so Omar’s team can review them together.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
    ],
  },
  {
    id: "nia-design-debrief",
    title: "Nia Brooks · Design Lead debrief",
    time: "Aug 27",
    preview: "Strong at keeping designs consistent. One project example needed before a hiring decision.",
    date: "Aug 27, 4:00 PM",
    participants: [
      {
        name: "Sergei Volkov",
        initials: "SV",
        color: "#6d8f68",
      },
      {
        name: "Nina Patel",
        initials: "NP",
        color: "#a56c79",
      },
      {
        name: "Marcus Lee",
        initials: "ML",
        color: "#8c7761",
      },
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "The panel sees strong design-system leadership in Nia but needs clearer evidence of how her decisions helped users.",
          "This was an internal debrief; Nia was not in the meeting.",
        ],
      },
      {
        heading: "Design-system leadership",
        bullets: [
          "Nia keeps shared components current, helps teams adopt them, and resolves disagreements about when a design should change.",
          "Designers and engineers get clear guidance without her approving every small decision, a strength across several product areas.",
        ],
      },
      {
        heading: "User impact",
        bullets: [
          "The panel could not connect what her team shipped to a problem users were having.",
          "They want what Nia personally decided, why, and what showed the experience improved. A clear research finding counts; a revenue metric is not required.",
        ],
      },
      {
        heading: "Follow-up format",
        bullets: [
          "A 30-minute walkthrough of one completed project she has already shown, with no take-home or new presentation.",
          "Cover the user problem, the alternatives she considered, what changed, and what she learned.",
        ],
      },
      {
        heading: "Decisions",
        bullets: ["Keep Nia in consideration for Design Lead and hold the decision until the follow-up."],
      },
      {
        heading: "Next steps",
        bullets: [
          "Sam will schedule the 30-minute project follow-up.",
          "Sergei will send Nia the discussion prompt.",
          "Nina will record the panel’s decision after the follow-up.",
          "Sam will add a user-impact question to the design interview guide.",
        ],
      },
    ],
    tasks: [
      {
        title: "Schedule Nia’s project follow-up",
        description: "Find 30 minutes with Nia, Sergei, and Nina to discuss one completed design project.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        title: "Send Nia the discussion prompt",
        description:
          "Ask for the user problem, her design choices, and what improved. Make clear that no new presentation or take-home work is needed.",
        owner: "Sergei Volkov",
        initials: "SV",
        color: "#6d8f68",
      },
      {
        title: "Record the panel’s decision after the follow-up",
        description: "Capture whether Nia’s example answers the remaining questions about her impact on users.",
        owner: "Nina Patel",
        initials: "NP",
        color: "#a56c79",
      },
      {
        id: "mine-design-guide",
        title: "Update the design interview guide",
        description:
          "Add a prompt that asks candidates to connect a design decision to a measurable improvement for users.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
    ],
    startedAt: "2026-08-27T16:00:00-07:00",
    sourceMemoryIds: ["m-179"],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "sofia-martinez",
    startedAt: "2026-08-27T15:00:00-07:00",
    title: "Sofia · Recruiting operations interview",
    time: "Aug 27",
    preview: "A clear approach to faster interview feedback; next, review her 30-day plan.",
    date: "Aug 27, 3:00 PM",
    participants: [
      {
        name: "Sofia Martinez",
        initials: "SM",
        color: "#b06d94",
      },
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Sofia has built recruiting operations at two distributed companies. Sam focused on how she would fix slow interview feedback without making the process harder for candidates.",
        ],
      },
      {
        heading: "Approach",
        bullets: [
          "She would start with clear role criteria, consistent interviewer scoring, and a weekly view of where candidates are waiting.",
          "She pushes back on opening a role before the team agrees how the decision will be made.",
        ],
      },
      {
        heading: "Decisions",
        bullets: [
          "Move Sofia to the hiring-manager round with a short operations case. No final decision has been made.",
        ],
      },
      {
        heading: "Next steps",
        bullets: ["Sam will send the case: a 30-day plan to improve interviewer scoring and feedback speed."],
      },
    ],
    tasks: [
      {
        title: "Send the recruiting operations case study",
        description: "Ask Sofia to outline a 30-day plan for improving interviewer calibration and feedback speed.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
    ],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "zoom-m-176",
    startedAt: "2026-08-27T12:47:00-07:00",
    sourceMemoryIds: ["m-176"],
    title: "Dana · Compensation expectations",
    preview:
      "Dana told Sam she is looking for a $275k base. Sam will check the approved range with Sergei before discussing a package. Dana’s permission to contact references, given on August 25, still stands.",
    time: "Aug 27",
    date: "Aug 27, 12:47 PM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Dana Okafor",
        initials: "DO",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Dana shared a $275k base target. Nothing has been offered or accepted; Sam will check the approved range first.",
        ],
      },
      {
        heading: "Compensation",
        bullets: ["Sam will compare Dana’s target with the approved band with Sergei before discussing a package."],
      },
      {
        heading: "References",
        bullets: ["Dana’s permission to contact her references, given on Aug 25, still stands."],
      },
      {
        heading: "Next steps",
        bullets: [
          "Sam will confirm the salary range with Sergei and follow up with Dana.",
          "Sam will coordinate Dana’s reference calls.",
        ],
      },
    ],
    tasks: [
      {
        id: "mine-dana-salary",
        title: "Confirm Dana’s salary range with Sergei",
        description:
          "Dana is waiting on a response to her $275k base target. Check the approved range before discussing a package.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        id: "mine-dana-references",
        title: "Coordinate Dana’s reference calls",
        description: "Dana has given permission. Confirm the contacts and find a time for each conversation.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
    ],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "zoom-m-172",
    startedAt: "2026-08-27T08:36:00-07:00",
    sourceMemoryIds: ["m-194", "m-193", "m-192", "m-177", "m-172"],
    title: "Meridian · Rollout review",
    preview:
      "You and Sophie are working closely on Meridian’s rollout and next phase of growth, while pricing, hiring, and expansion remain active topics. The latest work has focused on getting the rollout over the line and resolving the few decisions still holding things up.",
    time: "Aug 27",
    date: "Aug 27, 8:36 AM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Sophie Chen",
        initials: "SC",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "You and Sophie are working closely on Meridian’s rollout and next phase of growth, while pricing, hiring, and expansion remain active topics. The latest work has focused on getting the rollout over the line and resolving the few decisions still holding things up.",
        ],
      },
      {
        heading: "Rollout and hiring",
        bullets: [
          "The rollout can move forward once customer data is validated",
          "Pricing still needs final approval",
          "Two key hires are still open",
        ],
      },
      {
        heading: "Pricing and expansion",
        bullets: ["Pricing still needs final approval", "Europe expansion is now pushed to Q1"],
      },
      {
        heading: "Next steps",
        bullets: ["Pricing still needs final approval", "You owe Sophie the updated forecast"],
      },
    ],
    tasks: [
      {
        title: "Send Sophie the updated forecast",
        description: "Send Sophie the updated forecast before the next Meridian rollout review.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
    ],
    company: "Meridian",
    category: "Projects",
  },
  {
    id: "zoom-m-170",
    startedAt: "2026-08-26T16:32:00-07:00",
    sourceMemoryIds: ["m-170"],
    title: "Marta · Coaching reference follow-up",
    preview:
      "Marta confirmed that the three engineers Leo coached later joined permanent incident-command rotations. This answered Sam’s question about whether the coaching had a lasting effect.",
    time: "Aug 26",
    date: "Aug 26, 4:32 PM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Marta Silva",
        initials: "MS",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Marta confirmed that the three engineers Leo coached later joined permanent incident-command rotations. This answered Sam’s question about whether the coaching had a lasting effect.",
        ],
      },
      {
        heading: "Next steps",
        bullets: ["The reference follow-up is complete. Bring the answer into the hiring decision."],
      },
    ],
    tasks: [],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "zoom-m-167",
    startedAt: "2026-08-26T12:47:00-07:00",
    sourceMemoryIds: ["m-167"],
    title: "Meridian · Pricing and hiring",
    preview: "Pricing still needs final approval",
    time: "Aug 26",
    date: "Aug 26, 12:47 PM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Sophie Chen",
        initials: "SC",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: ["Pricing still needs final approval"],
      },
      {
        heading: "Rollout and hiring",
        bullets: [
          "The rollout can move forward once customer data is validated",
          "Pricing still needs final approval",
          "Two key hires are still open",
        ],
      },
      {
        heading: "Pricing and expansion",
        bullets: ["Pricing still needs final approval", "Europe expansion is now pushed to Q1"],
      },
      {
        heading: "Next steps",
        bullets: ["Pricing still needs final approval", "You owe Sophie the updated forecast"],
      },
    ],
    tasks: [
      {
        title: "Send Sophie the updated forecast",
        description: "Send Sophie the updated forecast before the next Meridian rollout review.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
    ],
    company: "Meridian",
    category: "Projects",
  },
  {
    id: "zoom-m-163",
    startedAt: "2026-08-26T08:36:00-07:00",
    sourceMemoryIds: ["m-163"],
    title: "Elena · Tomas’s final-review focus",
    preview:
      "Elena told Sam the recovery approach was strong. The remaining technical question is the multi-region capacity estimate.",
    time: "Aug 26",
    date: "Aug 26, 8:36 AM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Elena",
        initials: "E",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Elena rates Tomas’s recovery approach as strong. The one technical question left is the multi-region capacity estimate.",
        ],
      },
      {
        heading: "Decisions",
        bullets: [
          "Keep the final review focused on capacity and ownership instead of repeating the whole technical exercise.",
        ],
      },
      {
        heading: "Next steps",
        bullets: ["Sam will prepare the capacity question for Tomas’s final review."],
      },
    ],
    tasks: [
      {
        id: "mine-tomas-capacity",
        title: "Prepare the last question for Tomas’s final review",
        description:
          "Keep it focused on his multi-region capacity estimate; the recovery approach has already been covered.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
    ],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "zoom-m-161",
    startedAt: "2026-08-25T16:32:00-07:00",
    sourceMemoryIds: ["m-161"],
    title: "Dana · Working through disagreement",
    preview:
      "Dana described using customer clips to explain a design decision to a skeptical product partner. Sam asked how that discussion changed the final direction.",
    time: "Aug 25",
    date: "Aug 25, 4:32 PM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Dana Okafor",
        initials: "DO",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Dana described using customer clips to explain a design decision to a skeptical product partner. Sam asked how that discussion changed the final direction.",
        ],
      },
      {
        heading: "Next steps",
        bullets: ["Include the example in the collaboration feedback before the closing decision."],
      },
    ],
    tasks: [],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "liam-oconnor",
    startedAt: "2026-08-25T13:30:00-07:00",
    title: "Liam · Product marketing interview",
    time: "Aug 25",
    preview: "Strong launch storytelling; next, test how he uses adoption data.",
    date: "Aug 25, 1:30 PM",
    participants: [
      {
        name: "Liam O’Connor",
        initials: "LO",
        color: "#767fc0",
      },
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Emily Petrilla",
        initials: "EP",
        color: "#8c7761",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Liam walked Sam and Emily through a software launch he led and was clear on the customer problem, the message, and the work with sales and customer success.",
          "The gap is how he uses adoption data once a launch is live.",
        ],
      },
      {
        heading: "Adoption data",
        bullets: [
          "The next round should show which users he would focus on and what he would change if early usage misses expectations.",
        ],
      },
      {
        heading: "Decisions",
        bullets: ["Move Liam to a work-sample round before any hiring decision."],
      },
      {
        heading: "Next steps",
        bullets: [
          "Emily will prepare a short work sample using the planned collaboration launch and sample adoption data.",
          "Sam will schedule the review with the growth lead.",
        ],
      },
    ],
    tasks: [
      {
        title: "Prepare Liam’s work-sample prompt",
        description: "Use the upcoming collaboration launch and include a small set of generated adoption data.",
        owner: "Emily Petrilla",
        initials: "EP",
        color: "#8c7761",
      },
      {
        title: "Schedule the measurement follow-up",
        description: "Add the growth lead to the work-sample review panel.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
    ],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "zoom-m-158",
    startedAt: "2026-08-25T12:47:00-07:00",
    sourceMemoryIds: ["m-158"],
    title: "Tomas debrief · Technical result",
    preview:
      "Marcus and Elena liked Tomas’s recovery choices. Sam asked what remained open, and the group identified the multi-region capacity estimate.",
    time: "Aug 25",
    date: "Aug 25, 12:47 PM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Marcus Lee",
        initials: "ML",
        color: "#5b7f9e",
      },
      {
        name: "Elena",
        initials: "E",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Marcus and Elena liked Tomas’s recovery choices. Sam asked what remained open, and the group identified the multi-region capacity estimate.",
        ],
      },
      {
        heading: "Next steps",
        bullets: ["Keep that question for final review rather than repeating the whole technical exercise."],
      },
    ],
    tasks: [],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "zoom-m-154",
    startedAt: "2026-08-25T08:36:00-07:00",
    sourceMemoryIds: ["m-154"],
    title: "Sergei · Nia’s interview feedback",
    preview:
      "Sam and Sergei agreed that Nia’s design-system work was strong but the user outcome was still unclear. They discussed a focused follow-up instead of another broad portfolio review.",
    time: "Aug 25",
    date: "Aug 25, 8:36 AM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Sergei Volkov",
        initials: "SV",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Sam and Sergei agreed that Nia’s design-system work was strong but the user outcome was still unclear. They discussed a focused follow-up instead of another broad portfolio review.",
        ],
      },
      {
        heading: "Next steps",
        bullets: ["Bring a concrete follow-up plan to the panel before making a hiring decision."],
      },
    ],
    tasks: [],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "zoom-m-152",
    startedAt: "2026-08-24T16:32:00-07:00",
    sourceMemoryIds: ["m-180"],
    title: "Meridian · Europe expansion",
    preview: "Europe expansion is now pushed to Q1",
    time: "Aug 24",
    date: "Aug 24, 4:32 PM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Sophie Chen",
        initials: "SC",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: ["Europe expansion is now pushed to Q1"],
      },
      {
        heading: "Rollout and hiring",
        bullets: [
          "The rollout can move forward once customer data is validated",
          "Pricing still needs final approval",
          "Two key hires are still open",
        ],
      },
      {
        heading: "Pricing and expansion",
        bullets: ["Pricing still needs final approval", "Europe expansion is now pushed to Q1"],
      },
      {
        heading: "Next steps",
        bullets: ["Pricing still needs final approval", "You owe Sophie the updated forecast"],
      },
    ],
    tasks: [
      {
        title: "Send Sophie the updated forecast",
        description: "Send Sophie the updated forecast before the next Meridian rollout review.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
    ],
    company: "Meridian",
    category: "Projects",
  },
  {
    id: "zoom-m-149",
    startedAt: "2026-08-24T12:47:00-07:00",
    sourceMemoryIds: ["m-149"],
    title: "Tomas · Systems interview",
    preview:
      "Tomas protected the database and limited retries before increasing capacity. Sam explored the recovery order and the limits of the multi-region estimate.",
    time: "Aug 24",
    date: "Aug 24, 12:47 PM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Tomas Vane",
        initials: "TV",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Tomas protected the database and limited retries before increasing capacity. Sam explored the recovery order and the limits of the multi-region estimate.",
        ],
      },
      {
        heading: "Next steps",
        bullets: ["Take the result to debrief and update Tomas on next steps by August 27."],
      },
    ],
    tasks: [],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "zoom-m-145",
    startedAt: "2026-08-24T08:36:00-07:00",
    sourceMemoryIds: ["m-145"],
    title: "Marta · Reference for Leo",
    preview:
      "Marta described three engineers Leo helped develop into incident leaders. Sam asked which coaching behaviors made a difference.",
    time: "Aug 24",
    date: "Aug 24, 8:36 AM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Marta Silva",
        initials: "MS",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Marta described three engineers Leo helped develop into incident leaders. Sam asked which coaching behaviors made a difference.",
        ],
      },
      {
        heading: "Next steps",
        bullets: [
          "Review the examples with the hiring team and clarify whether those responsibilities lasted beyond the initial promotions.",
        ],
      },
    ],
    tasks: [],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "peter-cedar-onboarding",
    startedAt: "2026-08-22T14:22:00-07:00",
    sourceMemoryIds: ["m-186", "m-187", "m-188"],
    title: "Peter · Cedar pilot onboarding",
    preview:
      "Peter and Sam chose the next launch review as Cedar’s first pilot workflow. Each decision should keep its reasoning, owner, and follow-up date together. They will judge the pilot by five captured launch decisions, not by how many people log in.",
    time: "Aug 22",
    date: "Aug 22, 2:22 PM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Peter Lawson",
        initials: "PL",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Cedar’s pilot starts with the next launch review. Success means five launch decisions captured with their reasoning, owner, and follow-up date.",
        ],
      },
      {
        heading: "Pilot scope",
        bullets: [
          "Keeping each decision’s reasoning, owner, and follow-up date together should stop the team from repeating discussions between reviews.",
        ],
      },
      {
        heading: "Success measure",
        bullets: ["The pilot is judged by the five captured decisions, not by how many people log in."],
      },
      {
        heading: "Decisions",
        bullets: ["Start with launch reviews only. Discuss support reviews after seeing whether the pilot helps."],
      },
      {
        heading: "Next steps",
        bullets: [
          "Sam will check the decision template against Peter’s requirements.",
          "Sam will send Peter a short progress check-in.",
          "Sam will book the pilot review before Sep 11.",
        ],
      },
    ],
    tasks: [
      {
        id: "mine-cedar-review",
        title: "Schedule Cedar’s pilot review",
        description: "Agree on a time before September 11 to review the five launch decisions Peter is capturing.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        id: "mine-cedar-template",
        title: "Check Cedar’s decision template",
        description: "Make sure each entry has the reasoning, an owner, and a follow-up date, as Peter requested.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        id: "mine-cedar-checkin",
        title: "Draft a short Cedar pilot check-in",
        description: "Ask Peter which decisions have been captured and whether any context is still getting lost.",
        owner: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
    ],
    company: "Cedar Labs",
    category: "Customer Success",
  },
  {
    id: "zoom-m-143",
    startedAt: "2026-08-22T11:14:00-07:00",
    sourceMemoryIds: ["m-143"],
    title: "Tomas · Capacity limits",
    preview:
      "Tomas said a five-engineer team should limit demand before promising unlimited growth. Sam asked where he would draw that boundary and how he would explain it.",
    time: "Aug 22",
    date: "Aug 22, 11:14 AM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Tomas Vane",
        initials: "TV",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Tomas said a five-engineer team should limit demand before promising unlimited growth. Sam asked where he would draw that boundary and how he would explain it.",
        ],
      },
      {
        heading: "Next steps",
        bullets: ["Make the capacity assumptions explicit in the upcoming systems interview."],
      },
    ],
    tasks: [],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "zoom-m-141",
    startedAt: "2026-08-21T16:32:00-07:00",
    sourceMemoryIds: ["m-141"],
    title: "Dana · Product critique",
    preview:
      "Dana removed two onboarding steps but kept an important trust cue. She used five customer interviews to explain her priorities rather than relying on visual preference.",
    time: "Aug 21",
    date: "Aug 21, 4:32 PM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Dana Okafor",
        initials: "DO",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Dana removed two onboarding steps but kept an important trust cue. She used five customer interviews to explain her priorities rather than relying on visual preference.",
        ],
      },
      {
        heading: "Next steps",
        bullets: ["Carry the user-research examples into the cross-functional feedback."],
      },
    ],
    tasks: [],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "zoom-m-138",
    startedAt: "2026-08-21T12:47:00-07:00",
    sourceMemoryIds: ["m-138"],
    title: "Tomas · Recovery targets",
    preview:
      "Tomas proposed a two-region design with a 15-minute recovery target. Sam asked what it would support and where Tomas would set limits with the team.",
    time: "Aug 21",
    date: "Aug 21, 12:47 PM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Tomas Vane",
        initials: "TV",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Tomas proposed a two-region design with a 15-minute recovery target. Sam asked what it would support and where Tomas would set limits with the team.",
        ],
      },
      {
        heading: "Next steps",
        bullets: [
          "State those limits clearly in the technical round and explain what would need to change for more capacity.",
        ],
      },
    ],
    tasks: [],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "zoom-m-134",
    startedAt: "2026-08-21T08:36:00-07:00",
    sourceMemoryIds: ["m-134"],
    title: "Sergei · Design hiring check-in",
    preview:
      "Sergei wanted to keep both Dana and Nia moving after their portfolio work. Sam and Sergei agreed to arrange the next rounds while leaving room for other candidates.",
    time: "Aug 21",
    date: "Aug 21, 8:36 AM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Sergei Volkov",
        initials: "SV",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Sergei wanted to keep both Dana and Nia moving after their portfolio work. Sam and Sergei agreed to arrange the next rounds while leaving room for other candidates.",
        ],
      },
      {
        heading: "Next steps",
        bullets: ["Confirm the next interview schedules and keep the open questions specific to each candidate."],
      },
    ],
    tasks: [],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "zoom-m-132",
    startedAt: "2026-08-20T16:32:00-07:00",
    sourceMemoryIds: ["m-132"],
    title: "Marcus · Panel feedback plan",
    preview:
      "Marcus and Sam agreed to collect each interviewer’s scorecard before Tomas’s September 2 debrief. Early recommendations will not be circulated to the rest of the panel.",
    time: "Aug 20",
    date: "Aug 20, 4:32 PM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Marcus Lee",
        initials: "ML",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Marcus and Sam agreed to collect each interviewer’s scorecard before Tomas’s September 2 debrief. Early recommendations will not be circulated to the rest of the panel.",
        ],
      },
      {
        heading: "Next steps",
        bullets: ["Sam will collect the independent feedback before the group discussion."],
      },
    ],
    tasks: [],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "zoom-m-129",
    startedAt: "2026-08-20T12:47:00-07:00",
    sourceMemoryIds: ["m-129"],
    title: "Nia · Design-system walkthrough",
    preview:
      "Nia explained how she removed duplicate patterns and brought four teams onto one system. Sam asked what improved for users as well as for the designers working with it.",
    time: "Aug 20",
    date: "Aug 20, 12:47 PM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Nia Brooks",
        initials: "NB",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Nia explained how she removed duplicate patterns and brought four teams onto one system. Sam asked what improved for users as well as for the designers working with it.",
        ],
      },
      {
        heading: "Next steps",
        bullets: ["Review the portfolio feedback and identify whether a more focused project example is needed."],
      },
    ],
    tasks: [],
    company: "Highlight",
    category: "Recruiting",
  },
  {
    id: "zoom-m-125",
    startedAt: "2026-08-20T08:36:00-07:00",
    sourceMemoryIds: ["m-125"],
    title: "Leo debrief · Reference questions",
    preview:
      "Marcus and Elena confirmed that Leo’s technical feedback was complete. Sam asked what evidence they still needed about his coaching.",
    time: "Aug 20",
    date: "Aug 20, 8:36 AM",
    participants: [
      {
        name: "Sam Zetterberg",
        initials: "SZ",
        color: "#5b7f9e",
      },
      {
        name: "Marcus Lee",
        initials: "ML",
        color: "#5b7f9e",
      },
      {
        name: "Elena",
        initials: "E",
        color: "#5b7f9e",
      },
    ],
    notes: [
      {
        heading: "Overview",
        bullets: [
          "Marcus and Elena confirmed that Leo’s technical feedback was complete. Sam asked what evidence they still needed about his coaching.",
        ],
      },
      {
        heading: "Next steps",
        bullets: ["Ask Marta for a concrete example of an engineer Leo helped develop."],
      },
    ],
    tasks: [],
    company: "Highlight",
    category: "Recruiting",
  },
];

export const DEMO_PREVIEWS: Record<string, PersonPreview> = {
  "Danny Ocean": {
    summary:
      "Rusty introduced you to Danny, who is putting together eleven specialists for a project at the Bellagio. He says running three launches on the same night is the whole idea. On your last call, Danny confirmed Reuben is funding it, and you promised to review the security requirements with Livingston. You'll go over the full plan in person, since Danny prefers to keep it off email.",
    standing: [],
    sourceMemoryIds: ["danny-05", "danny-03", "danny-04", "danny-06", "danny-07"],
  },
  "Rusty Ryan": {
    summary:
      "Rusty introduced you to Danny and offered to coordinate between you. He prefers planning conversations in person, ideally over a meal.",
    standing: [],
    sourceMemoryIds: ["danny-03", "danny-01"],
  },
  Elena: {
    summary:
      "You and Elena are coordinating the remaining engineering interviews. She is helping clarify the open decisions and when Leo’s process can resume.",
    standing: [
      "Elena will confirm when Leo’s process can resume.",
      "You will collect the outstanding scorecards before the next hiring discussion.",
    ],
    sourceMemoryIds: ["m-029", "m-031", "m-068", "m-086", "m-128", "m-163"],
  },
  "Marcus Lee": {
    summary:
      "You and Marcus are collecting interview evidence before the next hiring discussion. You agreed to finish Tomas’s current round and keep Leo informed about the timing.",
    standing: [
      "Marcus is collecting the outstanding interview scorecards.",
      "You will give Leo an update when the timing is confirmed.",
    ],
    sourceMemoryIds: ["m-027", "m-030", "m-132", "m-175"],
  },
  "Nia Brooks": {
    summary:
      "Your conversations with Nia have established the team-facing value of her work. The remaining question is how her decisions changed the experience for the people using the product. You’ve asked for a focused follow-up to connect those pieces, and you’re waiting for her availability. The next conversation can build on the existing portfolio discussion without another assignment or deck.",
    standing: [
      "You sent the follow-up questions and asked for a 30-minute conversation. You’re waiting for Nia’s availability.",
      "You made clear that she doesn’t need a take-home assignment or a new deck.",
    ],
    sourceMemoryIds: ["m-109", "m-114", "m-129", "m-195"],
  },
  "Sergei Volkov": {
    summary:
      "Your recent work with Sergei has narrowed the search to different next steps for Dana and Nia. Dana’s conversation has moved toward compensation, while Nia needs a focused follow-up before a decision. You’re coordinating that follow-up and waiting for Sergei’s band check so you can respond to Dana without making an unsupported commitment.",
    standing: [
      "You agreed to arrange Nia’s focused follow-up and bring the result back before a hiring decision.",
      "Sergei is checking Dana’s $275k target against the approved band. You haven’t promised Dana that amount.",
    ],
    sourceMemoryIds: ["m-112", "m-134", "m-154", "m-166", "m-196", "m-179"],
  },
  "Tomas Vane": {
    summary:
      "Your discussions with Tomas have progressed from past experience to testing his judgment in a live technical conversation. You followed up as promised and told him the team wants to continue. The remaining review will focus on capacity, ownership, and mentoring; you’re waiting for his availability before booking it, with no hiring decision confirmed.",
    standing: [
      "You sent the remaining topics: capacity, ownership, and mentoring.",
      "You’re waiting for Tomas to confirm his availability for the final-review conversation.",
    ],
    sourceMemoryIds: ["m-034", "m-038", "m-102", "m-123", "m-143", "m-149", "m-153", "m-178"],
  },
  "Leo Chen": {
    summary:
      "Your conversations with Leo have built a record of his technical reasoning and how he follows through after incidents. He has helped move the reference process forward, but your latest update leaves the next interview undecided while the team finishes other conversations. You’ve kept him informed and owe him a follow-up when there is a decision.",
    standing: [
      "You’ve told Leo there is no next round to book yet.",
      "You said you would follow up when there is a decision. He hasn’t received that update in the recorded exchange.",
    ],
    sourceMemoryIds: ["m-048", "m-060", "m-092", "m-100", "m-165", "m-197"],
  },
  "Dana Okafor": {
    summary:
      "Your conversations with Dana have moved from understanding her work and collaboration style to finding a package that could work for both sides. References are complete, and she is waiting for your response on compensation. The immediate next step is to check the approved range with Sergei and return with a clear proposal; nothing has been agreed yet.",
    standing: [
      "Dana told you she wants a $275k base. You said you would check the range with Sergei before responding.",
      "She is waiting for your package update; no salary agreement has been made.",
    ],
    sourceMemoryIds: ["m-116", "m-120", "m-141", "m-161", "m-171", "m-176"],
  },
  "Anna Kowalski": {
    summary:
      "The conversation with Anna has not developed beyond your initial outreach. You’ve proposed a time and are waiting for a reply. Once she responds, the first conversation can establish mutual interest and give you something substantive to assess.",
    standing: ["You proposed Monday, August 31 for the screen.", "You’re waiting for Anna to confirm a time."],
    sourceMemoryIds: ["m-174"],
  },
  "Marta Silva": {
    summary:
      "Your exchange with Marta moved from an initial introduction to a focused reference call and a clarifying follow-up. Together, those conversations answered the question you were trying to resolve about Leo. The reference thread is complete, with no further request to Marta recorded.",
    standing: [
      "Marta confirmed that all three later joined permanent command rotations.",
      "Your reference questions are answered, with no further request to Marta recorded.",
    ],
    sourceMemoryIds: ["m-165", "m-145", "m-170"],
  },
  "Maya Torres": {
    summary:
      "Your exchange with Maya has set an outcome for the next account conversation, but progress against it has not yet been reviewed. You owe her an update that makes the remaining work clear. The relationship is still at that checkpoint, with no renewal commitment recorded.",
    standing: [
      "You owe Maya an adoption update at the next account check-in.",
      "No progress review or renewal commitment is recorded in your exchange yet.",
    ],
    sourceMemoryIds: ["m-181"],
  },
  "Peter Lawson": {
    summary:
      "Your relationship with Peter has moved from understanding a recurring frustration to trying a focused solution with his team. The next conversation should assess what the pilot actually helped them do. You’ve agreed to review five captured decisions before September 11; that review will give you a basis for deciding together what should happen next.",
    standing: [
      "You agreed to review five captured launch decisions before September 11.",
      "Peter wants to see whether the pilot is useful before discussing an expansion to support reviews.",
    ],
    sourceMemoryIds: ["m-182", "m-183", "m-184", "m-186", "m-187", "m-188"],
  },
  "Tom Ellis": {
    summary:
      "Your discussions with Tom surfaced a difference between his approach to incident response and what the team needs from this role. You explored that difference directly and communicated the outcome after the final review. The relationship has reached a clear stopping point, with no outstanding interview to arrange.",
    standing: [
      "You sent Tom the closing update on August 20 and thanked him for his time.",
      "You confirmed there would be no further interviews.",
    ],
    sourceMemoryIds: ["m-055", "m-087", "m-095", "m-130"],
  },
  "Jordan Kim": {
    summary:
      "Your conversations with Jordan have reached a successful conclusion, moving from mutual evaluation through negotiation to your welcome. The open questions raised during recruiting have been resolved in your exchanges. There is no remaining offer follow-up recorded, so the history now serves as context for the working relationship ahead.",
    standing: [
      "You confirmed receipt of his signed offer and welcomed him on August 12.",
      "The offer conversation is complete, with no outstanding recruiting question between you.",
    ],
    sourceMemoryIds: ["m-001", "m-007", "m-016", "m-024", "m-045", "m-077"],
  },
  "Eli Park": {
    summary:
      "Your conversations with Eli moved from dividing the evaluation work to reaching a shared decision on Jordan. The latest update closed the backup search while the remaining paperwork was being handled. Your recorded exchange with Eli stops there; it does not include a later message confirming that the process was fully closed.",
    standing: [
      "You agreed with Eli and Nora to stop pursuing the backup candidates.",
      "The last shared update still had paperwork pending; no later closing update to Eli is recorded.",
    ],
    sourceMemoryIds: ["m-010", "m-023", "m-070"],
  },
  "Nora Patel": {
    summary:
      "Your conversations with Nora helped move Jordan through the evaluation and align the team on a decision. The latest shared update shifted attention from comparing candidates to completing the process. You agreed to close the backup search, but no later closing update to Nora is recorded.",
    standing: [
      "You and Nora agreed to close the backup search while Jordan’s paperwork was completed.",
      "No follow-up confirming the paperwork to Nora is recorded yet.",
    ],
    sourceMemoryIds: ["m-005", "m-010", "m-023", "m-070"],
  },
  "Jussi Mäkinen": {
    summary:
      "Your exchange with Jussi opened a promising introduction for the engineering search. You acknowledged it and took responsibility for reviewing the background. The thread ends at that handoff, with no update back to him recorded yet.",
    standing: [
      "Your last exchange ended with you taking the referral forward.",
      "You haven’t sent Jussi a progress update in the recorded conversation.",
    ],
    sourceMemoryIds: ["m-037"],
  },
  "Maya Singh": {
    summary:
      "Your call with Maya gave you a direct response to the leadership question you wanted to resolve. The discussion provided context for Jordan’s evaluation and ended without another request. There is no open follow-up with her in the recorded history.",
    standing: [
      "Maya answered your leadership question with a concrete example.",
      "No further question to her is recorded after the reference call.",
    ],
    sourceMemoryIds: ["m-020"],
  },
  "Omar Haddad": {
    summary:
      "Your conversation with Omar established what needs to happen before the team proceeds. You’ve agreed on the order of work; the remaining task is to turn that agreement into a scheduled session. You owe him a proposed training time before the wider rollout can move forward.",
    standing: [
      "You need to agree on a training time with Omar.",
      "The wider rollout should wait until the training you discussed is covered.",
    ],
    sourceMemoryIds: ["m-190"],
  },
  "Nina Shah": {
    summary:
      "Your exchange with Nina has moved the expansion discussion into execution planning. You now need to send the contracting steps and establish a workable start date. The commercial response is positive, but those practical steps remain open before you can treat the kickoff as settled.",
    standing: [
      "You owe Nina the contracting steps and confirmation of whether September 15 is achievable.",
      "Her requested date has not yet been confirmed in your exchange.",
    ],
    sourceMemoryIds: ["m-189"],
  },
  "Iris Bennett": {
    summary:
      "Your conversations with Iris have progressed from what craft means to how she carries it through implementation. The interviews and follow-up checklist give you a concrete basis for the next discussion, with an unresolved usability issue still acknowledged. You’ve asked to explore engineering collaboration and shipping priorities in a final conversation and are waiting for her availability; no hiring decision is recorded.",
    standing: [
      "You asked Iris for a final conversation about working with engineers and deciding which details need to ship first. You are waiting for her availability; no hiring decision has been made.",
      "The checklist and the unresolved usability issue are in the follow-up email.",
    ],
    sourceMemoryIds: [
      "interview-iris-bennett-invitation",
      "interview-iris-bennett-screen",
      "interview-iris-bennett-review-request",
      "interview-iris-bennett-review",
      "interview-iris-bennett-answer",
      "interview-iris-bennett-next-step",
    ],
  },
  "Joaquin Reyes": {
    summary:
      "Your stakeholder check-in discussions with Joaquin have moved from understanding their contribution to checking the reasoning and limits behind it. Both interviews are complete, and their written follow-up is in. You now have the conversations and supporting evidence together to review before deciding what comes next. The opening is paused while the team confirms its hiring plan. You’ve told them you’ll reconnect if it reopens.",
    standing: [
      "You told Joaquin the opening is paused.",
      "There is no further interview booked. You will reach out if the hiring plan changes.",
    ],
    sourceMemoryIds: [
      "interview-joaquin-reyes-invitation",
      "interview-joaquin-reyes-screen",
      "interview-joaquin-reyes-review",
      "interview-joaquin-reyes-answer",
      "interview-joaquin-reyes-next-step",
    ],
  },
  "Natalie Sun": {
    summary:
      "Your usage review discussions with Natalie have moved from understanding their contribution to checking the reasoning and limits behind it. Both interviews are complete, and their written follow-up is in. You now have the conversations and supporting evidence together to review before deciding what comes next. You’ve asked for a final conversation and are waiting for availability; no time or hiring decision is confirmed.",
    standing: [
      "You asked Natalie for availability for a final conversation.",
      "You are waiting for a reply; no final time or hiring decision is recorded.",
    ],
    sourceMemoryIds: [
      "interview-natalie-sun-invitation",
      "interview-natalie-sun-screen",
      "interview-natalie-sun-review",
      "interview-natalie-sun-answer",
      "interview-natalie-sun-next-step",
    ],
  },
  "Kasper Sorensen": {
    summary:
      "Your quarterly review discussions with Kasper have moved from understanding their contribution to checking the reasoning and limits behind it. Both interviews are complete, and their written follow-up is in. You now have the conversations and supporting evidence together to review before deciding what comes next. You’re waiting for clarification on who owned the implementation handoff before deciding whether to arrange another interview.",
    standing: [
      "You asked Kasper who owned the handoff after their contribution.",
      "You are waiting for that clarification before deciding whether to arrange another interview.",
    ],
    sourceMemoryIds: [
      "interview-kasper-sorensen-invitation",
      "interview-kasper-sorensen-screen",
      "interview-kasper-sorensen-review",
      "interview-kasper-sorensen-answer",
      "interview-kasper-sorensen-next-step",
    ],
  },
  "Dalia Farah": {
    summary:
      "Your risk review discussions with Dalia have moved from understanding their contribution to checking the reasoning and limits behind it. Both interviews are complete, and their written follow-up is in. You now have the conversations and supporting evidence together to review before deciding what comes next. They want to finish their current project before continuing. You’ve agreed to wait for their timing update.",
    standing: [
      "Dalia asked to finish the current project before continuing.",
      "You agreed to wait for their update; no new interview date is set.",
    ],
    sourceMemoryIds: [
      "interview-dalia-farah-invitation",
      "interview-dalia-farah-screen",
      "interview-dalia-farah-review",
      "interview-dalia-farah-answer",
      "interview-dalia-farah-next-step",
    ],
  },
  "Cameron Nash": {
    summary:
      "Your expansion review discussions with Cameron have moved from understanding their contribution to checking the reasoning and limits behind it. Both interviews are complete, and their written follow-up is in. You now have the conversations and supporting evidence together to review before deciding what comes next. The opening is paused while the team confirms its hiring plan. You’ve told them you’ll reconnect if it reopens.",
    standing: [
      "You told Cameron the opening is paused.",
      "There is no further interview booked. You will reach out if the hiring plan changes.",
    ],
    sourceMemoryIds: [
      "interview-cameron-nash-invitation",
      "interview-cameron-nash-screen",
      "interview-cameron-nash-review",
      "interview-cameron-nash-answer",
      "interview-cameron-nash-next-step",
    ],
  },
  "Isabelle Marchand": {
    summary:
      "Your adoption check-in discussions with Isabelle have moved from understanding their contribution to checking the reasoning and limits behind it. Both interviews are complete, and their written follow-up is in. You now have the conversations and supporting evidence together to review before deciding what comes next. You’ve asked for a final conversation and are waiting for availability; no time or hiring decision is confirmed.",
    standing: [
      "You asked Isabelle for availability for a final conversation.",
      "You are waiting for a reply; no final time or hiring decision is recorded.",
    ],
    sourceMemoryIds: [
      "interview-isabelle-marchand-invitation",
      "interview-isabelle-marchand-screen",
      "interview-isabelle-marchand-review",
      "interview-isabelle-marchand-answer",
      "interview-isabelle-marchand-next-step",
    ],
  },
  "Ashwin Reddy": {
    summary:
      "Your account health review discussions with Ashwin have moved from understanding their contribution to checking the reasoning and limits behind it. Both interviews are complete, and their written follow-up is in. You now have the conversations and supporting evidence together to review before deciding what comes next. You’re waiting for clarification on who owned the implementation handoff before deciding whether to arrange another interview.",
    standing: [
      "You asked Ashwin who owned the handoff after their contribution.",
      "You are waiting for that clarification before deciding whether to arrange another interview.",
    ],
    sourceMemoryIds: [
      "interview-ashwin-reddy-invitation",
      "interview-ashwin-reddy-screen",
      "interview-ashwin-reddy-review",
      "interview-ashwin-reddy-answer",
      "interview-ashwin-reddy-next-step",
    ],
  },
  "Sophie Chen": {
    summary: SOPHIE_SUMMARY,
    standing: SOPHIE_STANDING,
    sourceMemoryIds: ["m-194", "m-193", "m-192", "m-177", "m-180", "m-172", "m-167"],
  },
};

export const DEMO_TRANSCRIPTS: Record<string, TranscriptTurn[]> = {
  "maya-sam-one-on-one": [],
  "website-launch-readiness": [],
  "danny-crew-timeline": [
    {
      speaker: "Danny Ocean",
      text: "Livingston has the security requirements. Can you go through them with him?",
      seconds: DEMO_TRANSCRIPT_SECONDS_300,
    },
    {
      speaker: "Sam Zetterberg",
      text: "I’ll set that up before we meet.",
      seconds: DEMO_TRANSCRIPT_SECONDS_309,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Who is covering the budget?",
      seconds: DEMO_TRANSCRIPT_SECONDS_1440,
    },
    {
      speaker: "Danny Ocean",
      text: "Reuben. He’s in.",
      seconds: DEMO_TRANSCRIPT_SECONDS_1446,
    },
    {
      speaker: "Danny Ocean",
      text: "The scope is ambitious and the timeline is tight.",
      seconds: DEMO_TRANSCRIPT_SECONDS_2400,
    },
    {
      speaker: "Danny Ocean",
      text: "But everyone has a part to play.",
      seconds: DEMO_TRANSCRIPT_SECONDS_2406,
    },
  ],
  "website-kickoff": [],
  "danny-intro-lunch": [
    {
      speaker: "Rusty Ryan",
      text: "Thanks for coming. Danny wanted to tell you about this himself.",
      seconds: 0,
    },
    {
      speaker: "Danny Ocean",
      text: "I need eleven people, and every one of them has a part to play.",
      seconds: DEMO_TRANSCRIPT_SECONDS_14,
    },
    {
      speaker: "Sam Zetterberg",
      text: "What would mine be?",
      seconds: DEMO_TRANSCRIPT_SECONDS_31,
    },
    {
      speaker: "Danny Ocean",
      text: "That’s what the next conversation is for.",
      seconds: DEMO_TRANSCRIPT_SECONDS_36,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Three launches on the same night? Is that realistic?",
      seconds: DEMO_TRANSCRIPT_SECONDS_312,
    },
    {
      speaker: "Danny Ocean",
      text: "That’s the whole idea.",
      seconds: DEMO_TRANSCRIPT_SECONDS_318,
    },
    {
      speaker: "Rusty Ryan",
      text: "Anything you need, you come to me.",
      seconds: DEMO_TRANSCRIPT_SECONDS_1320,
    },
    {
      speaker: "Rusty Ryan",
      text: "And we do these over food. It keeps everyone honest.",
      seconds: DEMO_TRANSCRIPT_SECONDS_1328,
    },
  ],
  "hiring-next-steps": [],
  "noah-williams": [],
  "beacon-rollout-readiness": [],
  "nia-design-debrief": [
    {
      seconds: 0,
      speaker: "Sam Zetterberg",
      text: "Thanks, everyone. This is our debrief on Nia Brooks for Design Lead. I'd like us to separate what we learned from the interviews from anything we still need to check, then agree on a next step.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_48,
      speaker: "Sergei Volkov",
      text: "The strongest part for me was how she works across teams. She was clear about how shared components get updated, who helps make those decisions, and how she gets people to actually use the system.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_135,
      speaker: "Marcus Lee",
      text: "I had the same reaction. When we asked what happens if engineering needs something the component library doesn't support, she didn't insist that every team wait for her. She described a way to try a change locally and then decide whether it belongs in the shared library.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_240,
      speaker: "Nina Patel",
      text: "That came through in the portfolio too. The screens were consistent and the guidance was easy to follow. I could see her helping a growing team avoid solving the same layout and interaction problems over and over.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_355,
      speaker: "Sam Zetterberg",
      text: "So we have a good signal on keeping the product consistent and helping people work together. What did we learn about how she decides which user problems to solve?",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_435,
      speaker: "Nina Patel",
      text: "That's where I still have a question. She walked us through the finished designs and explained the shared patterns, but I couldn't clearly follow the original user problem. I wanted to know what was difficult for people before the change.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_570,
      speaker: "Sergei Volkov",
      text: "I noticed that as well. We heard a lot about the process and what the team shipped. We heard less about why that was the right thing to ship or what happened when people started using it.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_690,
      speaker: "Marcus Lee",
      text: "I don't think we should assume she can't do that. We spent a lot of the interview on working with engineering and maintaining the system. We may need to ask more directly for the before-and-after story.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_815,
      speaker: "Nina Patel",
      text: "Agreed. This is a gap in the evidence, not a reason to reject her. I'd like one example where she can tell us what users struggled with, which options she considered, and why she chose the final approach.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_940,
      speaker: "Sam Zetterberg",
      text: "What kind of result would be enough? I want to give her a clear prompt without suggesting that every design project has to have a revenue number attached to it.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_1050,
      speaker: "Nina Patel",
      text: "It could be fewer mistakes in usability testing, people completing a task more easily, or a recurring support problem disappearing. Even a clear research finding would help. The important thing is that she can explain how she knows the design helped.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_1180,
      speaker: "Marcus Lee",
      text: "And let's ask what she personally contributed. She talked about the team's work, which is good, but for this role we also need to understand the choices she made and how she handled a tradeoff.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_1305,
      speaker: "Sergei Volkov",
      text: "Yes. We don't need another broad portfolio tour. One project in enough detail would be more useful. She can reuse something she has already shown us and spend the time on the reasoning.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_1430,
      speaker: "Sam Zetterberg",
      text: "I'll frame it as a 30-minute conversation, with no take-home assignment and no new deck. We'll send the questions in advance so she knows exactly what we still need to understand.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_1540,
      speaker: "Nina Patel",
      text: "That feels fair. I'd suggest we leave about half the time for her walkthrough and half for questions. If the result was different from what she expected, I'd like to hear what she learned and changed afterward.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_1670,
      speaker: "Marcus Lee",
      text: "That also gives us a better signal than asking for a perfect success story. I care about whether she notices when something isn't working and can explain what she does next.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_1800,
      speaker: "Sam Zetterberg",
      text: "Before I send the follow-up, let's make sure we're aligned on the hiring decision. We're keeping her in consideration, but we aren't ready to make the final call yet. Is that right?",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_1920,
      speaker: "Sergei Volkov",
      text: "Nia is good at keeping designs consistent across teams. What do we still need before making a decision?",
      isEvidence: true,
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_1935,
      speaker: "Nina Patel",
      text: "One clear example of how her work helped users. What problem did she solve, what did she change, and what got better?",
      isEvidence: true,
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_1965,
      speaker: "Marcus Lee",
      text: "That captures it. Her work with the system and the team is a strength. This next conversation should focus on the user problem and the outcome, so we don't repeat everything we've already covered.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_2000,
      speaker: "Sergei Volkov",
      text: "I'll send Sam a short prompt today. Nina, let's lead the follow-up together and then bring a recommendation back to the panel.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_2035,
      speaker: "Nina Patel",
      text: "Sounds good. I'll write up the remaining questions and update the decision after we've heard her example.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_2045,
      speaker: "Sam Zetterberg",
      text: "I'll add that user-impact question to the interview guide too. We should cover it in the first project discussion next time.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_2065,
      speaker: "Sam Zetterberg",
      text: "I'll find a time with Nia and send the context along with the invitation. No hiring decision until we've had that conversation. Thanks, everyone.",
    },
    {
      seconds: DEMO_TRANSCRIPT_SECONDS_2090,
      speaker: "Sergei Volkov",
      text: "Thanks. That gives us a clear next step.",
    },
  ],
  "sofia-martinez": [],
  "zoom-m-176": [
    {
      speaker: "Sam Zetterberg",
      text: "Thanks for making time, Dana. Before we get into Design Lead, is there anything you want to make sure we cover today?",
      seconds: 0,
    },
    {
      speaker: "Dana Okafor",
      text: "I'd like to leave with a clear decision and a shared understanding of what happens next. We have a few moving parts, so it would help to work through the reasoning together.",
      seconds: DEMO_TRANSCRIPT_SECONDS_27,
    },
    {
      speaker: "Sam Zetterberg",
      text: "That sounds good. Let's start with the context, look at the tradeoffs, and then reserve a few minutes for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_53,
    },
    {
      speaker: "Dana Okafor",
      text: "The main thing for me is that we keep the practical constraints in view. An approach can look good on paper and still be difficult to carry through if we haven't agreed on the details.",
      seconds: DEMO_TRANSCRIPT_SECONDS_80,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can you say a little more about how you would evaluate those details? What would you want us to check before moving forward?",
      seconds: DEMO_TRANSCRIPT_SECONDS_107,
    },
    {
      speaker: "Dana Okafor",
      text: "I'd start with the outcome we're trying to achieve, then work backward. We should know who is responsible, what information is still missing, and which decisions we can make with what we know now.",
      seconds: DEMO_TRANSCRIPT_SECONDS_133,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Right. I'd also like to distinguish what we've agreed from anything that's still an open question. That will make the follow-up easier for everyone who wasn't in this conversation.",
      seconds: DEMO_TRANSCRIPT_SECONDS_160,
    },
    {
      speaker: "Dana Okafor",
      text: "Exactly. Let's write down the reasoning alongside the decision so nobody has to reconstruct it later. There is one point I especially want to be clear about.",
      seconds: DEMO_TRANSCRIPT_SECONDS_187,
    },
    {
      speaker: "Sam Zetterberg",
      text: "What base would make the move work?",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_213,
    },
    {
      speaker: "Dana Okafor",
      text: "$275k is my ask.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_240,
    },
    {
      speaker: "Sam Zetterberg",
      text: "I’ll confirm Dana’s salary range with Sergei.",
      seconds: DEMO_TRANSCRIPT_SECONDS_267,
    },
    {
      speaker: "Sam Zetterberg",
      text: "I’ll coordinate Dana’s reference calls.",
      seconds: DEMO_TRANSCRIPT_SECONDS_293,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Got it. I'll preserve that wording in the notes. Is there any qualification we should include so the team doesn't read more into the decision than we intend?",
      seconds: DEMO_TRANSCRIPT_SECONDS_320,
    },
    {
      speaker: "Dana Okafor",
      text: "Just that this reflects what we know today. If new information changes the situation, I'd like us to discuss it explicitly instead of quietly carrying an old assumption forward.",
      seconds: DEMO_TRANSCRIPT_SECONDS_347,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Agreed. I'll make the next step clear in the follow-up and call out anything that still needs confirmation. We can keep the supporting context linked to the notes.",
      seconds: DEMO_TRANSCRIPT_SECONDS_373,
    },
    {
      speaker: "Dana Okafor",
      text: "That works for me. Please send the summary over so I can check that we've captured the important points accurately before anyone acts on it.",
      seconds: DEMO_TRANSCRIPT_SECONDS_400,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Will do. I'll share the notes after this meeting and leave room for corrections. Anything else we should cover before we wrap up?",
      seconds: DEMO_TRANSCRIPT_SECONDS_427,
    },
    {
      speaker: "Dana Okafor",
      text: "No, that covers it. Thanks for taking the time to work through this with me. I'll look out for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_453,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Thanks. We'll pick up from these notes next time. Have a good rest of your day.",
      seconds: DEMO_TRANSCRIPT_SECONDS_480,
    },
  ],
  "zoom-m-172": [
    {
      speaker: "Sam Zetterberg",
      text: "Where do we stand on Meridian’s rollout?",
      seconds: 0,
    },
    {
      speaker: "Sophie Chen",
      text: "We’re working closely on Meridian’s rollout and next phase of growth. Pricing, hiring, and expansion are still active topics, and we need to resolve the remaining decisions to get the rollout over the line.",
      seconds: DEMO_TRANSCRIPT_SECONDS_8,
    },
    {
      speaker: "Sophie Chen",
      text: "The rollout can move forward once customer data is validated",
      seconds: DEMO_TRANSCRIPT_SECONDS_25,
      isEvidence: true,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Pricing still needs final approval",
      seconds: DEMO_TRANSCRIPT_SECONDS_43,
      isEvidence: true,
    },
    {
      speaker: "Sophie Chen",
      text: "Two key hires are still open",
      seconds: DEMO_TRANSCRIPT_SECONDS_61,
      isEvidence: true,
    },
    {
      speaker: "Sophie Chen",
      text: "Pricing still needs final approval",
      seconds: DEMO_TRANSCRIPT_SECONDS_79,
      isEvidence: true,
    },
    {
      speaker: "Sophie Chen",
      text: "Europe expansion is now pushed to Q1",
      seconds: DEMO_TRANSCRIPT_SECONDS_97,
      isEvidence: true,
    },
    {
      speaker: "Sophie Chen",
      text: "You owe Sophie the updated forecast",
      seconds: DEMO_TRANSCRIPT_SECONDS_115,
      isEvidence: true,
    },
  ],
  "zoom-m-170": [
    {
      speaker: "Sam Zetterberg",
      text: "Thanks for making time, Marta. Before we get into Senior Backend, is there anything you want to make sure we cover today?",
      seconds: 0,
    },
    {
      speaker: "Marta Silva",
      text: "I'd like to leave with a clear decision and a shared understanding of what happens next. We have a few moving parts, so it would help to work through the reasoning together.",
      seconds: DEMO_TRANSCRIPT_SECONDS_30,
    },
    {
      speaker: "Sam Zetterberg",
      text: "That sounds good. Let's start with the context, look at the tradeoffs, and then reserve a few minutes for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_60,
    },
    {
      speaker: "Marta Silva",
      text: "The main thing for me is that we keep the practical constraints in view. An approach can look good on paper and still be difficult to carry through if we haven't agreed on the details.",
      seconds: DEMO_TRANSCRIPT_SECONDS_90,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can you say a little more about how you would evaluate those details? What would you want us to check before moving forward?",
      seconds: DEMO_TRANSCRIPT_SECONDS_120,
    },
    {
      speaker: "Marta Silva",
      text: "I'd start with the outcome we're trying to achieve, then work backward. We should know who is responsible, what information is still missing, and which decisions we can make with what we know now.",
      seconds: DEMO_TRANSCRIPT_SECONDS_150,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Right. I'd also like to distinguish what we've agreed from anything that's still an open question. That will make the follow-up easier for everyone who wasn't in this conversation.",
      seconds: DEMO_TRANSCRIPT_SECONDS_180,
    },
    {
      speaker: "Marta Silva",
      text: "Exactly. Let's write down the reasoning alongside the decision so nobody has to reconstruct it later. There is one point I especially want to be clear about.",
      seconds: DEMO_TRANSCRIPT_SECONDS_210,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Did those three engineers keep leading incidents after Leo’s coaching?",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_240,
    },
    {
      speaker: "Marta Silva",
      text: "Yes, all three later joined permanent incident-command rotations.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_270,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Got it. I'll preserve that wording in the notes. Is there any qualification we should include so the team doesn't read more into the decision than we intend?",
      seconds: DEMO_TRANSCRIPT_SECONDS_300,
    },
    {
      speaker: "Marta Silva",
      text: "Just that this reflects what we know today. If new information changes the situation, I'd like us to discuss it explicitly instead of quietly carrying an old assumption forward.",
      seconds: DEMO_TRANSCRIPT_SECONDS_330,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Agreed. I'll make the next step clear in the follow-up and call out anything that still needs confirmation. We can keep the supporting context linked to the notes.",
      seconds: DEMO_TRANSCRIPT_SECONDS_360,
    },
    {
      speaker: "Marta Silva",
      text: "That works for me. Please send the summary over so I can check that we've captured the important points accurately before anyone acts on it.",
      seconds: DEMO_TRANSCRIPT_SECONDS_390,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Will do. I'll share the notes after this meeting and leave room for corrections. Anything else we should cover before we wrap up?",
      seconds: DEMO_TRANSCRIPT_SECONDS_420,
    },
    {
      speaker: "Marta Silva",
      text: "No, that covers it. Thanks for taking the time to work through this with me. I'll look out for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_450,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Thanks. We'll pick up from these notes next time. Have a good rest of your day.",
      seconds: DEMO_TRANSCRIPT_SECONDS_480,
    },
  ],
  "zoom-m-167": [
    {
      speaker: "Sam Zetterberg",
      text: "Where do we stand on Meridian’s rollout?",
      seconds: 0,
    },
    {
      speaker: "Sophie Chen",
      text: "Pricing still needs final approval",
      seconds: DEMO_TRANSCRIPT_SECONDS_8,
    },
    {
      speaker: "Sophie Chen",
      text: "The rollout can move forward once customer data is validated",
      seconds: DEMO_TRANSCRIPT_SECONDS_25,
      isEvidence: true,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Pricing still needs final approval",
      seconds: DEMO_TRANSCRIPT_SECONDS_43,
      isEvidence: true,
    },
    {
      speaker: "Sophie Chen",
      text: "Two key hires are still open",
      seconds: DEMO_TRANSCRIPT_SECONDS_61,
      isEvidence: true,
    },
    {
      speaker: "Sophie Chen",
      text: "Pricing still needs final approval",
      seconds: DEMO_TRANSCRIPT_SECONDS_79,
      isEvidence: true,
    },
    {
      speaker: "Sophie Chen",
      text: "Europe expansion is now pushed to Q1",
      seconds: DEMO_TRANSCRIPT_SECONDS_97,
      isEvidence: true,
    },
    {
      speaker: "Sophie Chen",
      text: "You owe Sophie the updated forecast",
      seconds: DEMO_TRANSCRIPT_SECONDS_115,
      isEvidence: true,
    },
  ],
  "zoom-m-163": [
    {
      speaker: "Sam Zetterberg",
      text: "Thanks for making time, Elena. Before we get into Senior Backend, is there anything you want to make sure we cover today?",
      seconds: 0,
    },
    {
      speaker: "Elena",
      text: "I'd like to leave with a clear decision and a shared understanding of what happens next. We have a few moving parts, so it would help to work through the reasoning together.",
      seconds: DEMO_TRANSCRIPT_SECONDS_28,
    },
    {
      speaker: "Sam Zetterberg",
      text: "That sounds good. Let's start with the context, look at the tradeoffs, and then reserve a few minutes for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_56,
    },
    {
      speaker: "Elena",
      text: "The main thing for me is that we keep the practical constraints in view. An approach can look good on paper and still be difficult to carry through if we haven't agreed on the details.",
      seconds: DEMO_TRANSCRIPT_SECONDS_85,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can you say a little more about how you would evaluate those details? What would you want us to check before moving forward?",
      seconds: DEMO_TRANSCRIPT_SECONDS_113,
    },
    {
      speaker: "Elena",
      text: "I'd start with the outcome we're trying to achieve, then work backward. We should know who is responsible, what information is still missing, and which decisions we can make with what we know now.",
      seconds: DEMO_TRANSCRIPT_SECONDS_141,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Right. I'd also like to distinguish what we've agreed from anything that's still an open question. That will make the follow-up easier for everyone who wasn't in this conversation.",
      seconds: DEMO_TRANSCRIPT_SECONDS_169,
    },
    {
      speaker: "Elena",
      text: "Exactly. Let's write down the reasoning alongside the decision so nobody has to reconstruct it later. There is one point I especially want to be clear about.",
      seconds: DEMO_TRANSCRIPT_SECONDS_198,
    },
    {
      speaker: "Sam Zetterberg",
      text: "What is still unresolved for Tomas?",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_226,
    },
    {
      speaker: "Elena",
      text: "One multi-region capacity estimate.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_254,
    },
    {
      speaker: "Sam Zetterberg",
      text: "I’ll prepare the last question for Tomas’s final review.",
      seconds: DEMO_TRANSCRIPT_SECONDS_282,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Got it. I'll preserve that wording in the notes. Is there any qualification we should include so the team doesn't read more into the decision than we intend?",
      seconds: DEMO_TRANSCRIPT_SECONDS_311,
    },
    {
      speaker: "Elena",
      text: "Just that this reflects what we know today. If new information changes the situation, I'd like us to discuss it explicitly instead of quietly carrying an old assumption forward.",
      seconds: DEMO_TRANSCRIPT_SECONDS_339,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Agreed. I'll make the next step clear in the follow-up and call out anything that still needs confirmation. We can keep the supporting context linked to the notes.",
      seconds: DEMO_TRANSCRIPT_SECONDS_367,
    },
    {
      speaker: "Elena",
      text: "That works for me. Please send the summary over so I can check that we've captured the important points accurately before anyone acts on it.",
      seconds: DEMO_TRANSCRIPT_SECONDS_395,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Will do. I'll share the notes after this meeting and leave room for corrections. Anything else we should cover before we wrap up?",
      seconds: DEMO_TRANSCRIPT_SECONDS_424,
    },
    {
      speaker: "Elena",
      text: "No, that covers it. Thanks for taking the time to work through this with me. I'll look out for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_452,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Thanks. We'll pick up from these notes next time. Have a good rest of your day.",
      seconds: DEMO_TRANSCRIPT_SECONDS_480,
    },
  ],
  "zoom-m-161": [
    {
      speaker: "Sam Zetterberg",
      text: "Thanks for making time, Dana. Before we get into Design Lead, is there anything you want to make sure we cover today?",
      seconds: 0,
    },
    {
      speaker: "Dana Okafor",
      text: "I'd like to leave with a clear decision and a shared understanding of what happens next. We have a few moving parts, so it would help to work through the reasoning together.",
      seconds: DEMO_TRANSCRIPT_SECONDS_30,
    },
    {
      speaker: "Sam Zetterberg",
      text: "That sounds good. Let's start with the context, look at the tradeoffs, and then reserve a few minutes for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_60,
    },
    {
      speaker: "Dana Okafor",
      text: "The main thing for me is that we keep the practical constraints in view. An approach can look good on paper and still be difficult to carry through if we haven't agreed on the details.",
      seconds: DEMO_TRANSCRIPT_SECONDS_90,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can you say a little more about how you would evaluate those details? What would you want us to check before moving forward?",
      seconds: DEMO_TRANSCRIPT_SECONDS_120,
    },
    {
      speaker: "Dana Okafor",
      text: "I'd start with the outcome we're trying to achieve, then work backward. We should know who is responsible, what information is still missing, and which decisions we can make with what we know now.",
      seconds: DEMO_TRANSCRIPT_SECONDS_150,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Right. I'd also like to distinguish what we've agreed from anything that's still an open question. That will make the follow-up easier for everyone who wasn't in this conversation.",
      seconds: DEMO_TRANSCRIPT_SECONDS_180,
    },
    {
      speaker: "Dana Okafor",
      text: "Exactly. Let's write down the reasoning alongside the decision so nobody has to reconstruct it later. There is one point I especially want to be clear about.",
      seconds: DEMO_TRANSCRIPT_SECONDS_210,
    },
    {
      speaker: "Sam Zetterberg",
      text: "What moved the product lead?",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_240,
    },
    {
      speaker: "Dana Okafor",
      text: "Four customer clips made the tradeoff undeniable.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_270,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Got it. I'll preserve that wording in the notes. Is there any qualification we should include so the team doesn't read more into the decision than we intend?",
      seconds: DEMO_TRANSCRIPT_SECONDS_300,
    },
    {
      speaker: "Dana Okafor",
      text: "Just that this reflects what we know today. If new information changes the situation, I'd like us to discuss it explicitly instead of quietly carrying an old assumption forward.",
      seconds: DEMO_TRANSCRIPT_SECONDS_330,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Agreed. I'll make the next step clear in the follow-up and call out anything that still needs confirmation. We can keep the supporting context linked to the notes.",
      seconds: DEMO_TRANSCRIPT_SECONDS_360,
    },
    {
      speaker: "Dana Okafor",
      text: "That works for me. Please send the summary over so I can check that we've captured the important points accurately before anyone acts on it.",
      seconds: DEMO_TRANSCRIPT_SECONDS_390,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Will do. I'll share the notes after this meeting and leave room for corrections. Anything else we should cover before we wrap up?",
      seconds: DEMO_TRANSCRIPT_SECONDS_420,
    },
    {
      speaker: "Dana Okafor",
      text: "No, that covers it. Thanks for taking the time to work through this with me. I'll look out for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_450,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Thanks. We'll pick up from these notes next time. Have a good rest of your day.",
      seconds: DEMO_TRANSCRIPT_SECONDS_480,
    },
  ],
  "liam-oconnor": [],
  "zoom-m-158": [
    {
      speaker: "Sam Zetterberg",
      text: "Thanks for making time, Marcus. Before we get into Senior Backend, is there anything you want to make sure we cover today?",
      seconds: 0,
    },
    {
      speaker: "Marcus Lee",
      text: "I'd like to leave with a clear decision and a shared understanding of what happens next. We have a few moving parts, so it would help to work through the reasoning together.",
      seconds: DEMO_TRANSCRIPT_SECONDS_28,
    },
    {
      speaker: "Sam Zetterberg",
      text: "That sounds good. Let's start with the context, look at the tradeoffs, and then reserve a few minutes for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_56,
    },
    {
      speaker: "Marcus Lee",
      text: "The main thing for me is that we keep the practical constraints in view. An approach can look good on paper and still be difficult to carry through if we haven't agreed on the details.",
      seconds: DEMO_TRANSCRIPT_SECONDS_85,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can you say a little more about how you would evaluate those details? What would you want us to check before moving forward?",
      seconds: DEMO_TRANSCRIPT_SECONDS_113,
    },
    {
      speaker: "Marcus Lee",
      text: "I'd start with the outcome we're trying to achieve, then work backward. We should know who is responsible, what information is still missing, and which decisions we can make with what we know now.",
      seconds: DEMO_TRANSCRIPT_SECONDS_141,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Right. I'd also like to distinguish what we've agreed from anything that's still an open question. That will make the follow-up easier for everyone who wasn't in this conversation.",
      seconds: DEMO_TRANSCRIPT_SECONDS_169,
    },
    {
      speaker: "Marcus Lee",
      text: "Exactly. Let's write down the reasoning alongside the decision so nobody has to reconstruct it later. There is one point I especially want to be clear about.",
      seconds: DEMO_TRANSCRIPT_SECONDS_198,
    },
    {
      speaker: "Sam Zetterberg",
      text: "What should I cover when I follow up with Tomas?",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_226,
    },
    {
      speaker: "Marcus Lee",
      text: "Does the missing capacity estimate change your vote?",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_254,
    },
    {
      speaker: "Elena",
      text: "No, his containment sequence still earns a yes.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_282,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Got it. I'll preserve that wording in the notes. Is there any qualification we should include so the team doesn't read more into the decision than we intend?",
      seconds: DEMO_TRANSCRIPT_SECONDS_311,
    },
    {
      speaker: "Marcus Lee",
      text: "Just that this reflects what we know today. If new information changes the situation, I'd like us to discuss it explicitly instead of quietly carrying an old assumption forward.",
      seconds: DEMO_TRANSCRIPT_SECONDS_339,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Agreed. I'll make the next step clear in the follow-up and call out anything that still needs confirmation. We can keep the supporting context linked to the notes.",
      seconds: DEMO_TRANSCRIPT_SECONDS_367,
    },
    {
      speaker: "Marcus Lee",
      text: "That works for me. Please send the summary over so I can check that we've captured the important points accurately before anyone acts on it.",
      seconds: DEMO_TRANSCRIPT_SECONDS_395,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Will do. I'll share the notes after this meeting and leave room for corrections. Anything else we should cover before we wrap up?",
      seconds: DEMO_TRANSCRIPT_SECONDS_424,
    },
    {
      speaker: "Marcus Lee",
      text: "No, that covers it. Thanks for taking the time to work through this with me. I'll look out for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_452,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Thanks. We'll pick up from these notes next time. Have a good rest of your day.",
      seconds: DEMO_TRANSCRIPT_SECONDS_480,
    },
  ],
  "zoom-m-154": [
    {
      speaker: "Sam Zetterberg",
      text: "Thanks for making time, Sergei. Before we get into Design Lead, is there anything you want to make sure we cover today?",
      seconds: 0,
    },
    {
      speaker: "Sergei Volkov",
      text: "I'd like to leave with a clear decision and a shared understanding of what happens next. We have a few moving parts, so it would help to work through the reasoning together.",
      seconds: DEMO_TRANSCRIPT_SECONDS_30,
    },
    {
      speaker: "Sam Zetterberg",
      text: "That sounds good. Let's start with the context, look at the tradeoffs, and then reserve a few minutes for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_60,
    },
    {
      speaker: "Sergei Volkov",
      text: "The main thing for me is that we keep the practical constraints in view. An approach can look good on paper and still be difficult to carry through if we haven't agreed on the details.",
      seconds: DEMO_TRANSCRIPT_SECONDS_90,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can you say a little more about how you would evaluate those details? What would you want us to check before moving forward?",
      seconds: DEMO_TRANSCRIPT_SECONDS_120,
    },
    {
      speaker: "Sergei Volkov",
      text: "I'd start with the outcome we're trying to achieve, then work backward. We should know who is responsible, what information is still missing, and which decisions we can make with what we know now.",
      seconds: DEMO_TRANSCRIPT_SECONDS_150,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Right. I'd also like to distinguish what we've agreed from anything that's still an open question. That will make the follow-up easier for everyone who wasn't in this conversation.",
      seconds: DEMO_TRANSCRIPT_SECONDS_180,
    },
    {
      speaker: "Sergei Volkov",
      text: "Exactly. Let's write down the reasoning alongside the decision so nobody has to reconstruct it later. There is one point I especially want to be clear about.",
      seconds: DEMO_TRANSCRIPT_SECONDS_210,
    },
    {
      speaker: "Sergei Volkov",
      text: "Where was Nia strongest?",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_240,
    },
    {
      speaker: "Sam Zetterberg",
      text: "System governance; product storytelling was mixed.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_270,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Got it. I'll preserve that wording in the notes. Is there any qualification we should include so the team doesn't read more into the decision than we intend?",
      seconds: DEMO_TRANSCRIPT_SECONDS_300,
    },
    {
      speaker: "Sergei Volkov",
      text: "Just that this reflects what we know today. If new information changes the situation, I'd like us to discuss it explicitly instead of quietly carrying an old assumption forward.",
      seconds: DEMO_TRANSCRIPT_SECONDS_330,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Agreed. I'll make the next step clear in the follow-up and call out anything that still needs confirmation. We can keep the supporting context linked to the notes.",
      seconds: DEMO_TRANSCRIPT_SECONDS_360,
    },
    {
      speaker: "Sergei Volkov",
      text: "That works for me. Please send the summary over so I can check that we've captured the important points accurately before anyone acts on it.",
      seconds: DEMO_TRANSCRIPT_SECONDS_390,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Will do. I'll share the notes after this meeting and leave room for corrections. Anything else we should cover before we wrap up?",
      seconds: DEMO_TRANSCRIPT_SECONDS_420,
    },
    {
      speaker: "Sergei Volkov",
      text: "No, that covers it. Thanks for taking the time to work through this with me. I'll look out for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_450,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Thanks. We'll pick up from these notes next time. Have a good rest of your day.",
      seconds: DEMO_TRANSCRIPT_SECONDS_480,
    },
  ],
  "zoom-m-152": [
    {
      speaker: "Sam Zetterberg",
      text: "Where do we stand on Meridian’s rollout?",
      seconds: 0,
    },
    {
      speaker: "Sophie Chen",
      text: "Europe expansion is now pushed to Q1",
      seconds: DEMO_TRANSCRIPT_SECONDS_8,
    },
    {
      speaker: "Sophie Chen",
      text: "The rollout can move forward once customer data is validated",
      seconds: DEMO_TRANSCRIPT_SECONDS_25,
      isEvidence: true,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Pricing still needs final approval",
      seconds: DEMO_TRANSCRIPT_SECONDS_43,
      isEvidence: true,
    },
    {
      speaker: "Sophie Chen",
      text: "Two key hires are still open",
      seconds: DEMO_TRANSCRIPT_SECONDS_61,
      isEvidence: true,
    },
    {
      speaker: "Sophie Chen",
      text: "Pricing still needs final approval",
      seconds: DEMO_TRANSCRIPT_SECONDS_79,
      isEvidence: true,
    },
    {
      speaker: "Sophie Chen",
      text: "Europe expansion is now pushed to Q1",
      seconds: DEMO_TRANSCRIPT_SECONDS_97,
      isEvidence: true,
    },
    {
      speaker: "Sophie Chen",
      text: "You owe Sophie the updated forecast",
      seconds: DEMO_TRANSCRIPT_SECONDS_115,
      isEvidence: true,
    },
  ],
  "zoom-m-149": [
    {
      speaker: "Sam Zetterberg",
      text: "Thanks for making time, Tomas. Before we get into Senior Backend, is there anything you want to make sure we cover today?",
      seconds: 0,
    },
    {
      speaker: "Tomas Vane",
      text: "I'd like to leave with a clear decision and a shared understanding of what happens next. We have a few moving parts, so it would help to work through the reasoning together.",
      seconds: DEMO_TRANSCRIPT_SECONDS_30,
    },
    {
      speaker: "Sam Zetterberg",
      text: "That sounds good. Let's start with the context, look at the tradeoffs, and then reserve a few minutes for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_60,
    },
    {
      speaker: "Tomas Vane",
      text: "The main thing for me is that we keep the practical constraints in view. An approach can look good on paper and still be difficult to carry through if we haven't agreed on the details.",
      seconds: DEMO_TRANSCRIPT_SECONDS_90,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can you say a little more about how you would evaluate those details? What would you want us to check before moving forward?",
      seconds: DEMO_TRANSCRIPT_SECONDS_120,
    },
    {
      speaker: "Tomas Vane",
      text: "I'd start with the outcome we're trying to achieve, then work backward. We should know who is responsible, what information is still missing, and which decisions we can make with what we know now.",
      seconds: DEMO_TRANSCRIPT_SECONDS_150,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Right. I'd also like to distinguish what we've agreed from anything that's still an open question. That will make the follow-up easier for everyone who wasn't in this conversation.",
      seconds: DEMO_TRANSCRIPT_SECONDS_180,
    },
    {
      speaker: "Tomas Vane",
      text: "Exactly. Let's write down the reasoning alongside the decision so nobody has to reconstruct it later. There is one point I especially want to be clear about.",
      seconds: DEMO_TRANSCRIPT_SECONDS_210,
    },
    {
      speaker: "Sam Zetterberg",
      text: "The database is failing under retries; first move?",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_240,
    },
    {
      speaker: "Tomas Vane",
      text: "Bound retries and protect the database before scaling.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_270,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Got it. I'll preserve that wording in the notes. Is there any qualification we should include so the team doesn't read more into the decision than we intend?",
      seconds: DEMO_TRANSCRIPT_SECONDS_300,
    },
    {
      speaker: "Tomas Vane",
      text: "Just that this reflects what we know today. If new information changes the situation, I'd like us to discuss it explicitly instead of quietly carrying an old assumption forward.",
      seconds: DEMO_TRANSCRIPT_SECONDS_330,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Agreed. I'll make the next step clear in the follow-up and call out anything that still needs confirmation. We can keep the supporting context linked to the notes.",
      seconds: DEMO_TRANSCRIPT_SECONDS_360,
    },
    {
      speaker: "Tomas Vane",
      text: "That works for me. Please send the summary over so I can check that we've captured the important points accurately before anyone acts on it.",
      seconds: DEMO_TRANSCRIPT_SECONDS_390,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Will do. I'll share the notes after this meeting and leave room for corrections. Anything else we should cover before we wrap up?",
      seconds: DEMO_TRANSCRIPT_SECONDS_420,
    },
    {
      speaker: "Tomas Vane",
      text: "No, that covers it. Thanks for taking the time to work through this with me. I'll look out for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_450,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Thanks. We'll pick up from these notes next time. Have a good rest of your day.",
      seconds: DEMO_TRANSCRIPT_SECONDS_480,
    },
  ],
  "zoom-m-145": [
    {
      speaker: "Sam Zetterberg",
      text: "Thanks for making time, Marta. Before we get into Senior Backend, is there anything you want to make sure we cover today?",
      seconds: 0,
    },
    {
      speaker: "Marta Silva",
      text: "I'd like to leave with a clear decision and a shared understanding of what happens next. We have a few moving parts, so it would help to work through the reasoning together.",
      seconds: DEMO_TRANSCRIPT_SECONDS_30,
    },
    {
      speaker: "Sam Zetterberg",
      text: "That sounds good. Let's start with the context, look at the tradeoffs, and then reserve a few minutes for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_60,
    },
    {
      speaker: "Marta Silva",
      text: "The main thing for me is that we keep the practical constraints in view. An approach can look good on paper and still be difficult to carry through if we haven't agreed on the details.",
      seconds: DEMO_TRANSCRIPT_SECONDS_90,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can you say a little more about how you would evaluate those details? What would you want us to check before moving forward?",
      seconds: DEMO_TRANSCRIPT_SECONDS_120,
    },
    {
      speaker: "Marta Silva",
      text: "I'd start with the outcome we're trying to achieve, then work backward. We should know who is responsible, what information is still missing, and which decisions we can make with what we know now.",
      seconds: DEMO_TRANSCRIPT_SECONDS_150,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Right. I'd also like to distinguish what we've agreed from anything that's still an open question. That will make the follow-up easier for everyone who wasn't in this conversation.",
      seconds: DEMO_TRANSCRIPT_SECONDS_180,
    },
    {
      speaker: "Marta Silva",
      text: "Exactly. Let's write down the reasoning alongside the decision so nobody has to reconstruct it later. There is one point I especially want to be clear about.",
      seconds: DEMO_TRANSCRIPT_SECONDS_210,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Who grew under Leo's coaching?",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_240,
    },
    {
      speaker: "Marta Silva",
      text: "Three engineers took incident-command roles.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_270,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Got it. I'll preserve that wording in the notes. Is there any qualification we should include so the team doesn't read more into the decision than we intend?",
      seconds: DEMO_TRANSCRIPT_SECONDS_300,
    },
    {
      speaker: "Marta Silva",
      text: "Just that this reflects what we know today. If new information changes the situation, I'd like us to discuss it explicitly instead of quietly carrying an old assumption forward.",
      seconds: DEMO_TRANSCRIPT_SECONDS_330,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Agreed. I'll make the next step clear in the follow-up and call out anything that still needs confirmation. We can keep the supporting context linked to the notes.",
      seconds: DEMO_TRANSCRIPT_SECONDS_360,
    },
    {
      speaker: "Marta Silva",
      text: "That works for me. Please send the summary over so I can check that we've captured the important points accurately before anyone acts on it.",
      seconds: DEMO_TRANSCRIPT_SECONDS_390,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Will do. I'll share the notes after this meeting and leave room for corrections. Anything else we should cover before we wrap up?",
      seconds: DEMO_TRANSCRIPT_SECONDS_420,
    },
    {
      speaker: "Marta Silva",
      text: "No, that covers it. Thanks for taking the time to work through this with me. I'll look out for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_450,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Thanks. We'll pick up from these notes next time. Have a good rest of your day.",
      seconds: DEMO_TRANSCRIPT_SECONDS_480,
    },
  ],
  "peter-cedar-onboarding": [
    {
      speaker: "Sam Zetterberg",
      text: "Thanks for making time, Peter. Before we get into Cedar Labs’s rollout, is there anything you want to make sure we cover today?",
      seconds: 0,
    },
    {
      speaker: "Peter Lawson",
      text: "I'd like to leave with a clear decision and a shared understanding of what happens next. We have a few moving parts, so it would help to work through the reasoning together.",
      seconds: DEMO_TRANSCRIPT_SECONDS_83,
    },
    {
      speaker: "Sam Zetterberg",
      text: "That sounds good. Let's start with the context, look at the tradeoffs, and then reserve a few minutes for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_167,
    },
    {
      speaker: "Peter Lawson",
      text: "The main thing for me is that we keep the practical constraints in view. An approach can look good on paper and still be difficult to carry through if we haven't agreed on the details.",
      seconds: DEMO_TRANSCRIPT_SECONDS_250,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can you say a little more about how you would evaluate those details? What would you want us to check before moving forward?",
      seconds: DEMO_TRANSCRIPT_SECONDS_334,
    },
    {
      speaker: "Peter Lawson",
      text: "I'd start with the outcome we're trying to achieve, then work backward. We should know who is responsible, what information is still missing, and which decisions we can make with what we know now.",
      seconds: DEMO_TRANSCRIPT_SECONDS_417,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Right. I'd also like to distinguish what we've agreed from anything that's still an open question. That will make the follow-up easier for everyone who wasn't in this conversation.",
      seconds: DEMO_TRANSCRIPT_SECONDS_501,
    },
    {
      speaker: "Peter Lawson",
      text: "Exactly. Let's write down the reasoning alongside the decision so nobody has to reconstruct it later. There is one point I especially want to be clear about.",
      seconds: DEMO_TRANSCRIPT_SECONDS_584,
    },
    {
      speaker: "Peter Lawson",
      text: "Let’s start with our next launch review.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_668,
    },
    {
      speaker: "Sam Zetterberg",
      text: "We’ll use that as the first live workflow.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_751,
    },
    {
      speaker: "Peter Lawson",
      text: "Keep the owner, rationale, and follow-up together.",
      isEvidence: false,
      seconds: DEMO_TRANSCRIPT_SECONDS_835,
    },
    {
      speaker: "Sam Zetterberg",
      text: "I’ll add that structure to the onboarding page.",
      isEvidence: false,
      seconds: DEMO_TRANSCRIPT_SECONDS_918,
    },
    {
      speaker: "Sam Zetterberg",
      text: "What would make this pilot successful?",
      isEvidence: false,
      seconds: DEMO_TRANSCRIPT_SECONDS_1002,
    },
    {
      speaker: "Peter Lawson",
      text: "Five remembered launch decisions before September 11.",
      isEvidence: false,
      seconds: DEMO_TRANSCRIPT_SECONDS_1085,
    },
    {
      speaker: "Sam Zetterberg",
      text: "I’ll schedule Cedar’s pilot review.",
      seconds: DEMO_TRANSCRIPT_SECONDS_1169,
    },
    {
      speaker: "Sam Zetterberg",
      text: "I’ll check Cedar’s decision template.",
      seconds: DEMO_TRANSCRIPT_SECONDS_1252,
    },
    {
      speaker: "Sam Zetterberg",
      text: "I’ll draft a short Cedar pilot check-in.",
      seconds: DEMO_TRANSCRIPT_SECONDS_1336,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Got it. I'll preserve that wording in the notes. Is there any qualification we should include so the team doesn't read more into the decision than we intend?",
      seconds: DEMO_TRANSCRIPT_SECONDS_1419,
    },
    {
      speaker: "Peter Lawson",
      text: "Just that this reflects what we know today. If new information changes the situation, I'd like us to discuss it explicitly instead of quietly carrying an old assumption forward.",
      seconds: DEMO_TRANSCRIPT_SECONDS_1503,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Agreed. I'll make the next step clear in the follow-up and call out anything that still needs confirmation. We can keep the supporting context linked to the notes.",
      seconds: DEMO_TRANSCRIPT_SECONDS_1586,
    },
    {
      speaker: "Peter Lawson",
      text: "That works for me. Please send the summary over so I can check that we've captured the important points accurately before anyone acts on it.",
      seconds: DEMO_TRANSCRIPT_SECONDS_1670,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Will do. I'll share the notes after this meeting and leave room for corrections. Anything else we should cover before we wrap up?",
      seconds: DEMO_TRANSCRIPT_SECONDS_1753,
    },
    {
      speaker: "Peter Lawson",
      text: "No, that covers it. Thanks for taking the time to work through this with me. I'll look out for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_1837,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Thanks. We'll pick up from these notes next time. Have a good rest of your day.",
      seconds: DEMO_TRANSCRIPT_SECONDS_1920,
    },
  ],
  "zoom-m-143": [
    {
      speaker: "Sam Zetterberg",
      text: "Thanks for making time, Tomas. Before we get into Senior Backend, is there anything you want to make sure we cover today?",
      seconds: 0,
    },
    {
      speaker: "Tomas Vane",
      text: "I'd like to leave with a clear decision and a shared understanding of what happens next. We have a few moving parts, so it would help to work through the reasoning together.",
      seconds: DEMO_TRANSCRIPT_SECONDS_30,
    },
    {
      speaker: "Sam Zetterberg",
      text: "That sounds good. Let's start with the context, look at the tradeoffs, and then reserve a few minutes for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_60,
    },
    {
      speaker: "Tomas Vane",
      text: "The main thing for me is that we keep the practical constraints in view. An approach can look good on paper and still be difficult to carry through if we haven't agreed on the details.",
      seconds: DEMO_TRANSCRIPT_SECONDS_90,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can you say a little more about how you would evaluate those details? What would you want us to check before moving forward?",
      seconds: DEMO_TRANSCRIPT_SECONDS_120,
    },
    {
      speaker: "Tomas Vane",
      text: "I'd start with the outcome we're trying to achieve, then work backward. We should know who is responsible, what information is still missing, and which decisions we can make with what we know now.",
      seconds: DEMO_TRANSCRIPT_SECONDS_150,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Right. I'd also like to distinguish what we've agreed from anything that's still an open question. That will make the follow-up easier for everyone who wasn't in this conversation.",
      seconds: DEMO_TRANSCRIPT_SECONDS_180,
    },
    {
      speaker: "Tomas Vane",
      text: "Exactly. Let's write down the reasoning alongside the decision so nobody has to reconstruct it later. There is one point I especially want to be clear about.",
      seconds: DEMO_TRANSCRIPT_SECONDS_210,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can five engineers scale linearly?",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_240,
    },
    {
      speaker: "Tomas Vane",
      text: "No, I'd cap intake before promising that.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_270,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Got it. I'll preserve that wording in the notes. Is there any qualification we should include so the team doesn't read more into the decision than we intend?",
      seconds: DEMO_TRANSCRIPT_SECONDS_300,
    },
    {
      speaker: "Tomas Vane",
      text: "Just that this reflects what we know today. If new information changes the situation, I'd like us to discuss it explicitly instead of quietly carrying an old assumption forward.",
      seconds: DEMO_TRANSCRIPT_SECONDS_330,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Agreed. I'll make the next step clear in the follow-up and call out anything that still needs confirmation. We can keep the supporting context linked to the notes.",
      seconds: DEMO_TRANSCRIPT_SECONDS_360,
    },
    {
      speaker: "Tomas Vane",
      text: "That works for me. Please send the summary over so I can check that we've captured the important points accurately before anyone acts on it.",
      seconds: DEMO_TRANSCRIPT_SECONDS_390,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Will do. I'll share the notes after this meeting and leave room for corrections. Anything else we should cover before we wrap up?",
      seconds: DEMO_TRANSCRIPT_SECONDS_420,
    },
    {
      speaker: "Tomas Vane",
      text: "No, that covers it. Thanks for taking the time to work through this with me. I'll look out for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_450,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Thanks. We'll pick up from these notes next time. Have a good rest of your day.",
      seconds: DEMO_TRANSCRIPT_SECONDS_480,
    },
  ],
  "zoom-m-141": [
    {
      speaker: "Sam Zetterberg",
      text: "Thanks for making time, Dana. Before we get into Design Lead, is there anything you want to make sure we cover today?",
      seconds: 0,
    },
    {
      speaker: "Dana Okafor",
      text: "I'd like to leave with a clear decision and a shared understanding of what happens next. We have a few moving parts, so it would help to work through the reasoning together.",
      seconds: DEMO_TRANSCRIPT_SECONDS_30,
    },
    {
      speaker: "Sam Zetterberg",
      text: "That sounds good. Let's start with the context, look at the tradeoffs, and then reserve a few minutes for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_60,
    },
    {
      speaker: "Dana Okafor",
      text: "The main thing for me is that we keep the practical constraints in view. An approach can look good on paper and still be difficult to carry through if we haven't agreed on the details.",
      seconds: DEMO_TRANSCRIPT_SECONDS_90,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can you say a little more about how you would evaluate those details? What would you want us to check before moving forward?",
      seconds: DEMO_TRANSCRIPT_SECONDS_120,
    },
    {
      speaker: "Dana Okafor",
      text: "I'd start with the outcome we're trying to achieve, then work backward. We should know who is responsible, what information is still missing, and which decisions we can make with what we know now.",
      seconds: DEMO_TRANSCRIPT_SECONDS_150,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Right. I'd also like to distinguish what we've agreed from anything that's still an open question. That will make the follow-up easier for everyone who wasn't in this conversation.",
      seconds: DEMO_TRANSCRIPT_SECONDS_180,
    },
    {
      speaker: "Dana Okafor",
      text: "Exactly. Let's write down the reasoning alongside the decision so nobody has to reconstruct it later. There is one point I especially want to be clear about.",
      seconds: DEMO_TRANSCRIPT_SECONDS_210,
    },
    {
      speaker: "Sam Zetterberg",
      text: "What would you remove first?",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_240,
    },
    {
      speaker: "Dana Okafor",
      text: "Two onboarding steps, but I'd keep the trust cue.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_270,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Got it. I'll preserve that wording in the notes. Is there any qualification we should include so the team doesn't read more into the decision than we intend?",
      seconds: DEMO_TRANSCRIPT_SECONDS_300,
    },
    {
      speaker: "Dana Okafor",
      text: "Just that this reflects what we know today. If new information changes the situation, I'd like us to discuss it explicitly instead of quietly carrying an old assumption forward.",
      seconds: DEMO_TRANSCRIPT_SECONDS_330,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Agreed. I'll make the next step clear in the follow-up and call out anything that still needs confirmation. We can keep the supporting context linked to the notes.",
      seconds: DEMO_TRANSCRIPT_SECONDS_360,
    },
    {
      speaker: "Dana Okafor",
      text: "That works for me. Please send the summary over so I can check that we've captured the important points accurately before anyone acts on it.",
      seconds: DEMO_TRANSCRIPT_SECONDS_390,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Will do. I'll share the notes after this meeting and leave room for corrections. Anything else we should cover before we wrap up?",
      seconds: DEMO_TRANSCRIPT_SECONDS_420,
    },
    {
      speaker: "Dana Okafor",
      text: "No, that covers it. Thanks for taking the time to work through this with me. I'll look out for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_450,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Thanks. We'll pick up from these notes next time. Have a good rest of your day.",
      seconds: DEMO_TRANSCRIPT_SECONDS_480,
    },
  ],
  "zoom-m-138": [
    {
      speaker: "Sam Zetterberg",
      text: "Thanks for making time, Tomas. Before we get into Senior Backend, is there anything you want to make sure we cover today?",
      seconds: 0,
    },
    {
      speaker: "Tomas Vane",
      text: "I'd like to leave with a clear decision and a shared understanding of what happens next. We have a few moving parts, so it would help to work through the reasoning together.",
      seconds: DEMO_TRANSCRIPT_SECONDS_30,
    },
    {
      speaker: "Sam Zetterberg",
      text: "That sounds good. Let's start with the context, look at the tradeoffs, and then reserve a few minutes for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_60,
    },
    {
      speaker: "Tomas Vane",
      text: "The main thing for me is that we keep the practical constraints in view. An approach can look good on paper and still be difficult to carry through if we haven't agreed on the details.",
      seconds: DEMO_TRANSCRIPT_SECONDS_90,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can you say a little more about how you would evaluate those details? What would you want us to check before moving forward?",
      seconds: DEMO_TRANSCRIPT_SECONDS_120,
    },
    {
      speaker: "Tomas Vane",
      text: "I'd start with the outcome we're trying to achieve, then work backward. We should know who is responsible, what information is still missing, and which decisions we can make with what we know now.",
      seconds: DEMO_TRANSCRIPT_SECONDS_150,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Right. I'd also like to distinguish what we've agreed from anything that's still an open question. That will make the follow-up easier for everyone who wasn't in this conversation.",
      seconds: DEMO_TRANSCRIPT_SECONDS_180,
    },
    {
      speaker: "Tomas Vane",
      text: "Exactly. Let's write down the reasoning alongside the decision so nobody has to reconstruct it later. There is one point I especially want to be clear about.",
      seconds: DEMO_TRANSCRIPT_SECONDS_210,
    },
    {
      speaker: "Sam Zetterberg",
      text: "What boundary will you state?",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_240,
    },
    {
      speaker: "Tomas Vane",
      text: "Two regions and a 15-minute recovery goal.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_270,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Got it. I'll preserve that wording in the notes. Is there any qualification we should include so the team doesn't read more into the decision than we intend?",
      seconds: DEMO_TRANSCRIPT_SECONDS_300,
    },
    {
      speaker: "Tomas Vane",
      text: "Just that this reflects what we know today. If new information changes the situation, I'd like us to discuss it explicitly instead of quietly carrying an old assumption forward.",
      seconds: DEMO_TRANSCRIPT_SECONDS_330,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Agreed. I'll make the next step clear in the follow-up and call out anything that still needs confirmation. We can keep the supporting context linked to the notes.",
      seconds: DEMO_TRANSCRIPT_SECONDS_360,
    },
    {
      speaker: "Tomas Vane",
      text: "That works for me. Please send the summary over so I can check that we've captured the important points accurately before anyone acts on it.",
      seconds: DEMO_TRANSCRIPT_SECONDS_390,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Will do. I'll share the notes after this meeting and leave room for corrections. Anything else we should cover before we wrap up?",
      seconds: DEMO_TRANSCRIPT_SECONDS_420,
    },
    {
      speaker: "Tomas Vane",
      text: "No, that covers it. Thanks for taking the time to work through this with me. I'll look out for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_450,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Thanks. We'll pick up from these notes next time. Have a good rest of your day.",
      seconds: DEMO_TRANSCRIPT_SECONDS_480,
    },
  ],
  "zoom-m-134": [
    {
      speaker: "Sam Zetterberg",
      text: "Thanks for making time, Sergei. Before we get into Design Lead, is there anything you want to make sure we cover today?",
      seconds: 0,
    },
    {
      speaker: "Sergei Volkov",
      text: "I'd like to leave with a clear decision and a shared understanding of what happens next. We have a few moving parts, so it would help to work through the reasoning together.",
      seconds: DEMO_TRANSCRIPT_SECONDS_30,
    },
    {
      speaker: "Sam Zetterberg",
      text: "That sounds good. Let's start with the context, look at the tradeoffs, and then reserve a few minutes for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_60,
    },
    {
      speaker: "Sergei Volkov",
      text: "The main thing for me is that we keep the practical constraints in view. An approach can look good on paper and still be difficult to carry through if we haven't agreed on the details.",
      seconds: DEMO_TRANSCRIPT_SECONDS_90,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can you say a little more about how you would evaluate those details? What would you want us to check before moving forward?",
      seconds: DEMO_TRANSCRIPT_SECONDS_120,
    },
    {
      speaker: "Sergei Volkov",
      text: "I'd start with the outcome we're trying to achieve, then work backward. We should know who is responsible, what information is still missing, and which decisions we can make with what we know now.",
      seconds: DEMO_TRANSCRIPT_SECONDS_150,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Right. I'd also like to distinguish what we've agreed from anything that's still an open question. That will make the follow-up easier for everyone who wasn't in this conversation.",
      seconds: DEMO_TRANSCRIPT_SECONDS_180,
    },
    {
      speaker: "Sergei Volkov",
      text: "Exactly. Let's write down the reasoning alongside the decision so nobody has to reconstruct it later. There is one point I especially want to be clear about.",
      seconds: DEMO_TRANSCRIPT_SECONDS_210,
    },
    {
      speaker: "Sam Zetterberg",
      text: "How many portfolio slots remain?",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_240,
    },
    {
      speaker: "Sergei Volkov",
      text: "Three, so keep Dana and Nia active.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_270,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Got it. I'll preserve that wording in the notes. Is there any qualification we should include so the team doesn't read more into the decision than we intend?",
      seconds: DEMO_TRANSCRIPT_SECONDS_300,
    },
    {
      speaker: "Sergei Volkov",
      text: "Just that this reflects what we know today. If new information changes the situation, I'd like us to discuss it explicitly instead of quietly carrying an old assumption forward.",
      seconds: DEMO_TRANSCRIPT_SECONDS_330,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Agreed. I'll make the next step clear in the follow-up and call out anything that still needs confirmation. We can keep the supporting context linked to the notes.",
      seconds: DEMO_TRANSCRIPT_SECONDS_360,
    },
    {
      speaker: "Sergei Volkov",
      text: "That works for me. Please send the summary over so I can check that we've captured the important points accurately before anyone acts on it.",
      seconds: DEMO_TRANSCRIPT_SECONDS_390,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Will do. I'll share the notes after this meeting and leave room for corrections. Anything else we should cover before we wrap up?",
      seconds: DEMO_TRANSCRIPT_SECONDS_420,
    },
    {
      speaker: "Sergei Volkov",
      text: "No, that covers it. Thanks for taking the time to work through this with me. I'll look out for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_450,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Thanks. We'll pick up from these notes next time. Have a good rest of your day.",
      seconds: DEMO_TRANSCRIPT_SECONDS_480,
    },
  ],
  "zoom-m-132": [
    {
      speaker: "Sam Zetterberg",
      text: "Thanks for making time, Marcus. Before we get into Member of Technical Staff, is there anything you want to make sure we cover today?",
      seconds: 0,
    },
    {
      speaker: "Marcus Lee",
      text: "I'd like to leave with a clear decision and a shared understanding of what happens next. We have a few moving parts, so it would help to work through the reasoning together.",
      seconds: DEMO_TRANSCRIPT_SECONDS_30,
    },
    {
      speaker: "Sam Zetterberg",
      text: "That sounds good. Let's start with the context, look at the tradeoffs, and then reserve a few minutes for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_60,
    },
    {
      speaker: "Marcus Lee",
      text: "The main thing for me is that we keep the practical constraints in view. An approach can look good on paper and still be difficult to carry through if we haven't agreed on the details.",
      seconds: DEMO_TRANSCRIPT_SECONDS_90,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can you say a little more about how you would evaluate those details? What would you want us to check before moving forward?",
      seconds: DEMO_TRANSCRIPT_SECONDS_120,
    },
    {
      speaker: "Marcus Lee",
      text: "I'd start with the outcome we're trying to achieve, then work backward. We should know who is responsible, what information is still missing, and which decisions we can make with what we know now.",
      seconds: DEMO_TRANSCRIPT_SECONDS_150,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Right. I'd also like to distinguish what we've agreed from anything that's still an open question. That will make the follow-up easier for everyone who wasn't in this conversation.",
      seconds: DEMO_TRANSCRIPT_SECONDS_180,
    },
    {
      speaker: "Marcus Lee",
      text: "Exactly. Let's write down the reasoning alongside the decision so nobody has to reconstruct it later. There is one point I especially want to be clear about.",
      seconds: DEMO_TRANSCRIPT_SECONDS_210,
    },
    {
      speaker: "Marcus Lee",
      text: "When should scorecards be visible?",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_240,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Only after all four interviewers submit.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_270,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Got it. I'll preserve that wording in the notes. Is there any qualification we should include so the team doesn't read more into the decision than we intend?",
      seconds: DEMO_TRANSCRIPT_SECONDS_300,
    },
    {
      speaker: "Marcus Lee",
      text: "Just that this reflects what we know today. If new information changes the situation, I'd like us to discuss it explicitly instead of quietly carrying an old assumption forward.",
      seconds: DEMO_TRANSCRIPT_SECONDS_330,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Agreed. I'll make the next step clear in the follow-up and call out anything that still needs confirmation. We can keep the supporting context linked to the notes.",
      seconds: DEMO_TRANSCRIPT_SECONDS_360,
    },
    {
      speaker: "Marcus Lee",
      text: "That works for me. Please send the summary over so I can check that we've captured the important points accurately before anyone acts on it.",
      seconds: DEMO_TRANSCRIPT_SECONDS_390,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Will do. I'll share the notes after this meeting and leave room for corrections. Anything else we should cover before we wrap up?",
      seconds: DEMO_TRANSCRIPT_SECONDS_420,
    },
    {
      speaker: "Marcus Lee",
      text: "No, that covers it. Thanks for taking the time to work through this with me. I'll look out for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_450,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Thanks. We'll pick up from these notes next time. Have a good rest of your day.",
      seconds: DEMO_TRANSCRIPT_SECONDS_480,
    },
  ],
  "zoom-m-129": [
    {
      speaker: "Sam Zetterberg",
      text: "Thanks for making time, Nia. Before we get into Design Lead, is there anything you want to make sure we cover today?",
      seconds: 0,
    },
    {
      speaker: "Nia Brooks",
      text: "I'd like to leave with a clear decision and a shared understanding of what happens next. We have a few moving parts, so it would help to work through the reasoning together.",
      seconds: DEMO_TRANSCRIPT_SECONDS_30,
    },
    {
      speaker: "Sam Zetterberg",
      text: "That sounds good. Let's start with the context, look at the tradeoffs, and then reserve a few minutes for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_60,
    },
    {
      speaker: "Nia Brooks",
      text: "The main thing for me is that we keep the practical constraints in view. An approach can look good on paper and still be difficult to carry through if we haven't agreed on the details.",
      seconds: DEMO_TRANSCRIPT_SECONDS_90,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can you say a little more about how you would evaluate those details? What would you want us to check before moving forward?",
      seconds: DEMO_TRANSCRIPT_SECONDS_120,
    },
    {
      speaker: "Nia Brooks",
      text: "I'd start with the outcome we're trying to achieve, then work backward. We should know who is responsible, what information is still missing, and which decisions we can make with what we know now.",
      seconds: DEMO_TRANSCRIPT_SECONDS_150,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Right. I'd also like to distinguish what we've agreed from anything that's still an open question. That will make the follow-up easier for everyone who wasn't in this conversation.",
      seconds: DEMO_TRANSCRIPT_SECONDS_180,
    },
    {
      speaker: "Nia Brooks",
      text: "Exactly. Let's write down the reasoning alongside the decision so nobody has to reconstruct it later. There is one point I especially want to be clear about.",
      seconds: DEMO_TRANSCRIPT_SECONDS_210,
    },
    {
      speaker: "Sam Zetterberg",
      text: "How did you win adoption?",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_240,
    },
    {
      speaker: "Nia Brooks",
      text: "I retired 18 duplicates with four product teams.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_270,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Got it. I'll preserve that wording in the notes. Is there any qualification we should include so the team doesn't read more into the decision than we intend?",
      seconds: DEMO_TRANSCRIPT_SECONDS_300,
    },
    {
      speaker: "Nia Brooks",
      text: "Just that this reflects what we know today. If new information changes the situation, I'd like us to discuss it explicitly instead of quietly carrying an old assumption forward.",
      seconds: DEMO_TRANSCRIPT_SECONDS_330,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Agreed. I'll make the next step clear in the follow-up and call out anything that still needs confirmation. We can keep the supporting context linked to the notes.",
      seconds: DEMO_TRANSCRIPT_SECONDS_360,
    },
    {
      speaker: "Nia Brooks",
      text: "That works for me. Please send the summary over so I can check that we've captured the important points accurately before anyone acts on it.",
      seconds: DEMO_TRANSCRIPT_SECONDS_390,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Will do. I'll share the notes after this meeting and leave room for corrections. Anything else we should cover before we wrap up?",
      seconds: DEMO_TRANSCRIPT_SECONDS_420,
    },
    {
      speaker: "Nia Brooks",
      text: "No, that covers it. Thanks for taking the time to work through this with me. I'll look out for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_450,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Thanks. We'll pick up from these notes next time. Have a good rest of your day.",
      seconds: DEMO_TRANSCRIPT_SECONDS_480,
    },
  ],
  "zoom-m-125": [
    {
      speaker: "Sam Zetterberg",
      text: "Thanks for making time, Marcus. Before we get into Senior Backend, is there anything you want to make sure we cover today?",
      seconds: 0,
    },
    {
      speaker: "Marcus Lee",
      text: "I'd like to leave with a clear decision and a shared understanding of what happens next. We have a few moving parts, so it would help to work through the reasoning together.",
      seconds: DEMO_TRANSCRIPT_SECONDS_28,
    },
    {
      speaker: "Sam Zetterberg",
      text: "That sounds good. Let's start with the context, look at the tradeoffs, and then reserve a few minutes for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_56,
    },
    {
      speaker: "Marcus Lee",
      text: "The main thing for me is that we keep the practical constraints in view. An approach can look good on paper and still be difficult to carry through if we haven't agreed on the details.",
      seconds: DEMO_TRANSCRIPT_SECONDS_85,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Can you say a little more about how you would evaluate those details? What would you want us to check before moving forward?",
      seconds: DEMO_TRANSCRIPT_SECONDS_113,
    },
    {
      speaker: "Marcus Lee",
      text: "I'd start with the outcome we're trying to achieve, then work backward. We should know who is responsible, what information is still missing, and which decisions we can make with what we know now.",
      seconds: DEMO_TRANSCRIPT_SECONDS_141,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Right. I'd also like to distinguish what we've agreed from anything that's still an open question. That will make the follow-up easier for everyone who wasn't in this conversation.",
      seconds: DEMO_TRANSCRIPT_SECONDS_169,
    },
    {
      speaker: "Marcus Lee",
      text: "Exactly. Let's write down the reasoning alongside the decision so nobody has to reconstruct it later. There is one point I especially want to be clear about.",
      seconds: DEMO_TRANSCRIPT_SECONDS_198,
    },
    {
      speaker: "Sam Zetterberg",
      text: "What should I ask Marta in Leo’s reference call?",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_226,
    },
    {
      speaker: "Marcus Lee",
      text: "Leo cleared all four technical signals.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_254,
    },
    {
      speaker: "Elena",
      text: "I still need one concrete coaching reference.",
      isEvidence: true,
      seconds: DEMO_TRANSCRIPT_SECONDS_282,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Got it. I'll preserve that wording in the notes. Is there any qualification we should include so the team doesn't read more into the decision than we intend?",
      seconds: DEMO_TRANSCRIPT_SECONDS_311,
    },
    {
      speaker: "Marcus Lee",
      text: "Just that this reflects what we know today. If new information changes the situation, I'd like us to discuss it explicitly instead of quietly carrying an old assumption forward.",
      seconds: DEMO_TRANSCRIPT_SECONDS_339,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Agreed. I'll make the next step clear in the follow-up and call out anything that still needs confirmation. We can keep the supporting context linked to the notes.",
      seconds: DEMO_TRANSCRIPT_SECONDS_367,
    },
    {
      speaker: "Marcus Lee",
      text: "That works for me. Please send the summary over so I can check that we've captured the important points accurately before anyone acts on it.",
      seconds: DEMO_TRANSCRIPT_SECONDS_395,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Will do. I'll share the notes after this meeting and leave room for corrections. Anything else we should cover before we wrap up?",
      seconds: DEMO_TRANSCRIPT_SECONDS_424,
    },
    {
      speaker: "Marcus Lee",
      text: "No, that covers it. Thanks for taking the time to work through this with me. I'll look out for the follow-up.",
      seconds: DEMO_TRANSCRIPT_SECONDS_452,
    },
    {
      speaker: "Sam Zetterberg",
      text: "Thanks. We'll pick up from these notes next time. Have a good rest of your day.",
      seconds: DEMO_TRANSCRIPT_SECONDS_480,
    },
  ],
};

export const DEMO_UPCOMING: { id: string; title: string; start: string; end: string; participants: string[] }[] = [
  {
    id: "danny-plan-walkthrough",
    title: "Bellagio plan walkthrough",
    start: "2026-09-07T12:30:00-07:00",
    end: "2026-09-07T13:30:00-07:00",
    participants: ["Sam Zetterberg", "Danny Ocean", "Rusty Ryan"],
  },
  {
    id: "website-launch-check-in",
    title: "Website launch check-in",
    start: "2026-09-07T10:00:00-07:00",
    end: "2026-09-07T10:30:00-07:00",
    participants: ["Maya Lin", "Marcus Lee", "Nina Patel", "Sam Zetterberg"],
  },
  {
    id: "sophie-rollout-next-steps",
    title: "Sophie · Meridian rollout",
    start: "2026-09-07T14:00:00-07:00",
    end: "2026-09-07T14:30:00-07:00",
    participants: ["Sophie Chen", "Sam Zetterberg"],
  },
];
