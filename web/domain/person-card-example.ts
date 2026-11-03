import type { AmbientContextPrivateDetails } from "@readymeet/shared";

import { createAmbientContextItem } from "./testing/ambient-context-fixture";

// Synthetic person card for reviewing the per-viewer sections. No real data.
export const PERSON = createAmbientContextItem({
  id: "44444444-4444-4444-8444-444444444444",
  entityKind: "person",
  canonicalKey: "person:priya nair",
  displayName: "Priya Nair",
  professionalTitle: "Staff Engineer",
  companyName: "Northstar Labs",
  qualifier: "Northstar Labs",
  status: "ready",
  summary: "Staff engineer at Northstar Labs focused on service reliability.",
  facts: ["Leads weekly failure reviews that cut repeat incidents by 26%."],
  citations: [
    {
      title: "Priya Nair on building more reliable services",
      domain: "example.com",
      url: "https://example.com/articles/reliable-services",
      excerpt: "Illustrative interview with Priya Nair about reliability engineering.",
      isArticle: true,
    },
  ],
});
export const PRIVATE_DETAILS: AmbientContextPrivateDetails = {
  memory: {
    personId: "55555555-5555-4555-8555-555555555555",
    name: "Priya Nair",
    summary: [
      "Marcus and Elena see Priya as their first choice.",
      "She wants to stay hands-on as an IC and can’t relocate.",
    ],
    standing: ["You agreed on Priya’s next steps with Marcus and Elena", "Priya told you she wants an IC role"],
    lastContact: null,
  },
  ashby: {
    candidateName: "Priya Nair",
    profileUrl: "https://app.ashbyhq.com/candidates/example",
    facts: [
      "Applied for Staff Engineer · Onsite",
      "Status: Active",
      "Source: Referral",
      "Hiring team: Marcus Lee (Hiring Manager), Elena (Recruiter)",
      "Last updated Sep 2, 2026",
    ],
  },
};
