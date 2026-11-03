import { z } from "zod";

export const capabilityCategoryValues = [
  "communication",
  "documentation",
  "execution",
  "state_sync",
  "coordination",
  "investigation",
  "preparation",
] as const;

export const sideEffectScopeValues = ["none", "private_draft", "shared_draft", "external_action"] as const;

export const meetingTypeValues = [
  "team_sync",
  "one_on_one",
  "sales_call",
  "customer_success",
  "product_review",
  "standup",
  "hiring_debrief",
  "exec_review",
  "planning",
  "brainstorm",
  "interview",
  "retrospective",
  "postmortem",
  "manager_check_in",
  "other",
] as const;

const SIGNAL_KEY_VALUES = [
  "external_participants_present",
  "decisions_made",
  "open_questions_remain",
  "action_commitments_made",
  "customer_objections_raised",
  "crm_relevant_context",
  "product_or_feature_discussion",
  "engineering_issue_identified",
  "follow_up_meeting_referenced",
  "research_question_identified",
  "web_research_task_identified",
  "purely_informational",
  "routine_status_sync",
] as const;
const EXAMPLE_TRIGGER_MIN_ITEMS = 2;
const EXAMPLE_TRIGGER_MAX_ITEMS = 4;
const CAPABILITY_PRIORITY_MINIMUM = 1;
const CAPABILITY_PRIORITY_MAXIMUM = 100;
const DEFAULT_CAPABILITY_PRIORITY = 50;
const CAPABILITY_KEY_FORMAT_ERROR_MESSAGE = "Capability keys must be snake_case identifiers";
const UNKNOWN_CAPABILITY_SIGNAL_ERROR_MESSAGE = ({
  capabilityKey,
  signalKey,
}: {
  capabilityKey: string;
  signalKey: string;
}): string => `Capability "${capabilityKey}" references unknown signal "${signalKey}"`;

export const signalRegistry = {
  external_participants_present: {
    description: [
      "Definition: the meeting includes at least one person who is not part of the host organization, such as a candidate, customer, prospect, partner, vendor, or other external party.",
      'Triggers: "Thanks for taking the time to interview with us today.", "If the pricing works, let us meet next Tuesday with procurement.", interviews where the candidate is external, sales calls, customer calls, and partner syncs.',
      "Does NOT trigger: an internal meeting where someone is from a different team or department but still the same company.",
      "Explicit guidance: recruiting and interview conversations always include at least one external participant because the candidate is external.",
    ].join(" "),
  },
  decisions_made: {
    description: [
      "Definition: one or more concrete decisions were reached.",
      'Triggers: "Let’s go with Postgres.", "We will launch the redesign in May instead of April."',
      'Does NOT trigger: process continuation, next-step commitments, or interview progression such as "we’ll move you to the next round" or "I’ll review your materials and follow up."',
    ].join(" "),
  },
  open_questions_remain: {
    description: [
      "Definition: unresolved substantive questions remained at the end of the meeting.",
      'Triggers: "We still need to decide whether approach A or approach B is safer.", "It is still unclear which pricing model customers prefer."',
      "Does NOT trigger: procedural uncertainty about scheduling, next-meeting format, process steps, or interview logistics.",
    ].join(" "),
  },
  action_commitments_made: {
    description: [
      "Definition: the meeting contains explicit task, follow-up, assignment, or next-step language that should be tracked after the meeting.",
      'Does NOT trigger: vague discussion of possible work, exploratory debugging with no requested task, or generic statements like "we should think about this."',
      'Explicit guidance: imperative task requests and agreed next steps can trigger even when the speaker does not say "I commit."',
    ].join(" "),
  },
  customer_objections_raised: {
    description: "A prospect or customer raised objections or concerns.",
  },
  crm_relevant_context: {
    description: [
      "Definition: the meeting substantively involves a specific customer account, sales opportunity, pipeline stage, renewal, deal dynamics, or customer success engagement. The meeting content, not just its mention, must be CRM-relevant.",
      "Triggers: a sales call discussing pricing and next steps with a specific prospect; a customer success review of a specific account's health and renewal risk; a pipeline review discussing named deals and their progression.",
      "Does NOT trigger: a passing mention that the company sells to businesses, has enterprise customers, or is launching a sales motion.",
      "Does NOT trigger: general discussion of go-to-market strategy without reference to specific accounts.",
      "Does NOT trigger: a recruiter, engineer, or designer mentioning the company's customers while describing the business. The signal requires the meeting itself to be about account or pipeline activity.",
    ].join(" "),
  },
  product_or_feature_discussion: {
    description: [
      "Definition: substantive discussion of product direction, features, specs, or technical decisions where participants are actively making or evaluating product choices.",
      'Triggers: "Should we ship the dashboard redesign this quarter or push it?", "The API should support pagination via cursor rather than offset."',
      "Does NOT trigger: a recruiter or salesperson describing the company product to an outsider. One-way product exposition to someone external is not product discussion.",
      'Does NOT trigger: casual mentions of products used, such as "we use Linear."',
    ].join(" "),
  },
  engineering_issue_identified: {
    description: "A bug, defect, or technical problem surfaced.",
  },
  follow_up_meeting_referenced: {
    description: [
      "Definition: participants explicitly mention a future meeting, interview round, working session, or scheduled next interaction.",
      'Triggers: "Let\'s schedule a follow-up.", "I\'ll send you a calendar invite for the next round.", "We\'ll have a working session with the hiring manager next week.", "I\'ll email you a scheduling link."',
      'Does NOT trigger: a vague statement like "we should catch up sometime" with no plan to schedule.',
    ].join(" "),
  },
  research_question_identified: {
    description: [
      "Definition: an unresolved substantive question requires investigation, analysis, or fact-finding beyond the meeting before the group can proceed confidently.",
      'Triggers: "Can someone verify whether this API limit applies to enterprise tenants?", "We need to research competitor pricing before deciding."',
      "Does NOT trigger: an interviewer inviting questions, a participant asking if anyone has questions, or generic role-exploration prompts.",
      "Does NOT trigger: ordinary curiosity about the company, team, or interview process unless the meeting explicitly frames it as follow-up research work.",
    ].join(" "),
  },
  web_research_task_identified: {
    description: [
      "Definition: the meeting includes a request or question that would benefit from web-backed research, entity discovery, URL/PDF extraction, comparison, or structured data collection after the meeting.",
      'Triggers: "Find and compare 20 relevant companies.", "Extract useful details from these pages and PDFs.", "Build a structured dataset from the open web.", "Research current competitors and cite sources."',
      "Does NOT trigger: casual curiosity, simple internal follow-up questions, or topics answerable entirely from the meeting transcript.",
      "Explicit guidance: trigger when Search, Extract, FindAll, or deep synthesis could materially help complete the request.",
    ].join(" "),
  },
  purely_informational: {
    description: "Meeting was one-way information sharing without decisions or commitments.",
  },
  routine_status_sync: {
    description: "Meeting was a routine status update without substantive decisions.",
  },
} as const satisfies Record<(typeof SIGNAL_KEY_VALUES)[number], { description: string }>;

export type SignalKey = (typeof SIGNAL_KEY_VALUES)[number];

export const capabilityCategorySchema = z.enum(capabilityCategoryValues);
export const sideEffectScopeSchema = z.enum(sideEffectScopeValues);
export const meetingTypeSchema = z.enum(meetingTypeValues);
export const signalKeySchema = z.enum(SIGNAL_KEY_VALUES);

export const signalReferenceSchema = z.object({
  key: signalKeySchema,
  description: z.string().trim().min(1).optional(),
});

export const capabilityCatalogInputSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, CAPABILITY_KEY_FORMAT_ERROR_MESSAGE),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  category: capabilityCategorySchema,
  applicableMeetingTypes: z.array(meetingTypeSchema).min(1),
  requiredSignals: z.array(signalReferenceSchema),
  exclusionSignals: z.array(signalReferenceSchema),
  exampleTriggers: z.array(z.string().trim().min(1)).min(EXAMPLE_TRIGGER_MIN_ITEMS).max(EXAMPLE_TRIGGER_MAX_ITEMS),
  sideEffectScope: sideEffectScopeSchema,
  defaultPriority: z
    .number()
    .int()
    .min(CAPABILITY_PRIORITY_MINIMUM)
    .max(CAPABILITY_PRIORITY_MAXIMUM)
    .default(DEFAULT_CAPABILITY_PRIORITY),
  isActive: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const capabilityCatalogRowSchema = capabilityCatalogInputSchema.extend({
  id: z.string().uuid(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const userCapabilityViewSchema = capabilityCatalogInputSchema.extend({
  id: z.string().uuid(),
  isEnabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SignalReference = z.infer<typeof signalReferenceSchema>;
export type CapabilityCategory = z.infer<typeof capabilityCategorySchema>;
export type SideEffectScope = z.infer<typeof sideEffectScopeSchema>;
export type MeetingType = z.infer<typeof meetingTypeSchema>;
export type CapabilityCatalogInput = z.infer<typeof capabilityCatalogInputSchema>;
export type CapabilityCatalogRow = z.infer<typeof capabilityCatalogRowSchema>;
export type UserCapabilityView = z.infer<typeof userCapabilityViewSchema>;

export function validateCapabilitySignalReferences(
  capabilities: readonly Pick<CapabilityCatalogInput, "key" | "requiredSignals" | "exclusionSignals">[],
): void {
  capabilities.forEach((capability) => {
    [...capability.requiredSignals, ...capability.exclusionSignals].forEach((reference) => {
      if (!(reference.key in signalRegistry)) {
        throw new Error(
          UNKNOWN_CAPABILITY_SIGNAL_ERROR_MESSAGE({ capabilityKey: capability.key, signalKey: reference.key }),
        );
      }
    });
  });
}
