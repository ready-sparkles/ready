import {
  type CapabilityCatalogInput,
  capabilityCatalogInputSchema,
  validateCapabilitySignalReferences,
} from "@readymeet/shared";

const CUSTOMER_FOLLOW_UP_PRIORITY = 88;
const MEETING_COACHING_PRIORITY = 40;
const PARTICIPANT_FOLLOW_UP_PRIORITY = 39;
const FILE_ISSUE_OR_BUG_PRIORITY = 84;
const UPDATE_CRM_PRIORITY = 92;
const SCHEDULE_FOLLOW_UP_PRIORITY = 72;
const RESEARCH_OPEN_QUESTION_PRIORITY = 78;
const DUPLICATE_CAPABILITY_KEY_MESSAGE = 'Duplicate capability key "{key}" in seed data';

export const capabilityCatalogSeed: CapabilityCatalogInput[] = [
  {
    key: "draft_external_follow_up",
    name: "Customer Follow-Up",
    description: "Draft a follow-up message for external participants with promises, asks, and next steps.",
    category: "communication",
    applicableMeetingTypes: ["sales_call", "customer_success", "interview", "other"],
    requiredSignals: [
      {
        key: "external_participants_present",
        description: "This capability is only relevant when someone outside the host organization attended.",
      },
      {
        key: "action_commitments_made",
        description: "The follow-up should reflect concrete commitments or promised follow-through.",
      },
    ],
    exclusionSignals: [
      {
        key: "purely_informational",
        description: "A passive informational call should not trigger an external follow-up draft.",
      },
    ],
    exampleTriggers: [
      "I’ll send the pricing breakdown and security doc right after this call.",
      "Can you follow up with the onboarding timeline and owners?",
      "Let’s recap the agreed pilot next steps for the customer in writing.",
    ],
    sideEffectScope: "private_draft",
    defaultPriority: CUSTOMER_FOLLOW_UP_PRIORITY,
    isActive: true,
    metadata: {
      integrationTargets: ["Gmail", "Outlook", "HubSpot", "Salesforce"],
    },
  },
  {
    key: "meeting_coaching",
    name: "Meeting Feedback",
    description: "Review the meeting and suggest ways to make the next one clearer, tighter, and more useful.",
    category: "preparation",
    applicableMeetingTypes: [
      "team_sync",
      "one_on_one",
      "sales_call",
      "customer_success",
      "product_review",
      "standup",
      "interview",
      "planning",
      "brainstorm",
      "retrospective",
      "postmortem",
      "manager_check_in",
      "other",
    ],
    requiredSignals: [],
    exclusionSignals: [],
    exampleTriggers: [
      "Give me feedback on how this meeting went.",
      "Help me improve the next version of this conversation.",
    ],
    sideEffectScope: "none",
    defaultPriority: MEETING_COACHING_PRIORITY,
    isActive: true,
    metadata: {
      /** @external existing wire contract */
      alwaysAvailable: true,
      integrationTargets: [],
    },
  },
  {
    key: "draft_participant_follow_up",
    name: "Participant Follow-Up",
    description: "Draft a follow-up message for the meeting participants without sending anything automatically.",
    category: "communication",
    applicableMeetingTypes: [
      "team_sync",
      "one_on_one",
      "sales_call",
      "customer_success",
      "product_review",
      "standup",
      "interview",
      "planning",
      "brainstorm",
      "retrospective",
      "postmortem",
      "manager_check_in",
      "other",
    ],
    requiredSignals: [],
    exclusionSignals: [],
    exampleTriggers: [
      "Draft a follow-up for the people in this meeting.",
      "Help me send everyone a clear recap after this conversation.",
    ],
    sideEffectScope: "private_draft",
    defaultPriority: PARTICIPANT_FOLLOW_UP_PRIORITY,
    isActive: true,
    metadata: {
      /** @external existing wire contract */
      alwaysAvailable: true,
      integrationTargets: ["Gmail", "Outlook"],
    },
  },
  {
    key: "file_issue_or_bug",
    name: "Bug Report",
    description: "File engineering issues from surfaced defects with impact, severity, and reproduction context.",
    category: "execution",
    applicableMeetingTypes: ["team_sync", "product_review", "standup", "planning", "postmortem", "other"],
    requiredSignals: [
      {
        key: "engineering_issue_identified",
        description: "This capability applies when a concrete defect or technical failure surfaced.",
      },
    ],
    exclusionSignals: [
      {
        key: "purely_informational",
        description: "Passive informational discussion should not create engineering issues.",
      },
    ],
    exampleTriggers: [
      "The export job is silently failing for enterprise accounts after midnight.",
      "We found a reproducible crash in the settings flow when SSO is enabled.",
      "This sounds like a real bug; we should file it with steps and impact.",
    ],
    sideEffectScope: "external_action",
    defaultPriority: FILE_ISSUE_OR_BUG_PRIORITY,
    isActive: true,
    metadata: {
      integrationTargets: ["Linear", "GitHub Issues", "Jira", "Azure DevOps"],
    },
  },
  {
    key: "update_crm",
    name: "CRM Update",
    description: "Capture account, opportunity, renewal, or customer context for the system of record.",
    category: "state_sync",
    applicableMeetingTypes: ["sales_call", "customer_success", "other"],
    requiredSignals: [
      {
        key: "crm_relevant_context",
        description: "The discussion must include pipeline, account, renewal, or deal context worth recording.",
      },
      {
        key: "external_participants_present",
        description: "CRM updates are only relevant when the conversation involved an external contact.",
      },
    ],
    exclusionSignals: [
      {
        key: "purely_informational",
        description: "A passive informational exchange should not trigger a CRM writeback.",
      },
    ],
    exampleTriggers: [
      "The prospect pushed back on implementation timing and wants legal review next week.",
      "We learned the deal is blocked on procurement, security, and budget timing.",
      "Please update the CRM with the new champion, objections, and renewal risk.",
    ],
    sideEffectScope: "external_action",
    defaultPriority: UPDATE_CRM_PRIORITY,
    isActive: true,
    metadata: {
      integrationTargets: ["Salesforce", "HubSpot", "Dynamics 365"],
    },
  },
  {
    key: "schedule_follow_up",
    name: "Schedule Follow-Up",
    description: "Prepare the handoff for a next meeting when participants explicitly ask to reconnect.",
    category: "coordination",
    applicableMeetingTypes: [
      "one_on_one",
      "sales_call",
      "customer_success",
      "product_review",
      "exec_review",
      "planning",
      "interview",
      "manager_check_in",
      "other",
    ],
    requiredSignals: [
      {
        key: "follow_up_meeting_referenced",
        description: "The meeting must explicitly reference another meeting or check-in.",
      },
    ],
    exclusionSignals: [
      {
        key: "routine_status_sync",
        description: "Standing recurring syncs should not repeatedly surface ad hoc scheduling.",
      },
    ],
    exampleTriggers: [
      "Let’s get 30 minutes on the calendar next Tuesday to review the pilot results.",
      "We should schedule a technical deep dive with the implementation lead and security.",
      "Can someone set up the follow-up once we have the revised proposal ready?",
    ],
    sideEffectScope: "external_action",
    defaultPriority: SCHEDULE_FOLLOW_UP_PRIORITY,
    isActive: true,
    metadata: {
      integrationTargets: ["Google Calendar", "Outlook Calendar", "Calendly"],
    },
  },
  {
    key: "research_open_question",
    name: "Deep Research",
    description:
      "Run durable web-backed research, extraction, entity discovery, and synthesis for a meeting topic or requested research task.",
    category: "investigation",
    applicableMeetingTypes: [
      "sales_call",
      "customer_success",
      "product_review",
      "planning",
      "brainstorm",
      "exec_review",
      "postmortem",
      "other",
    ],
    requiredSignals: [
      {
        key: "web_research_task_identified",
        description:
          "This capability applies when the meeting surfaced a web-backed research, extraction, discovery, comparison, or dataset task.",
      },
    ],
    exclusionSignals: [
      {
        key: "purely_informational",
        description: "Informational meetings should not trigger research workflows by default.",
      },
    ],
    exampleTriggers: [
      "Find and compare 20 relevant companies for this market.",
      "Extract useful details from these pages and PDFs.",
      "Build a structured dataset from the open web.",
      "Research current competitors and return a sourced summary.",
    ],
    sideEffectScope: "none",
    defaultPriority: RESEARCH_OPEN_QUESTION_PRIORITY,
    isActive: true,
    metadata: {
      integrationTargets: ["Parallel Search", "Parallel Extract", "Parallel FindAll", "Deep Synthesis"],
    },
  },
];

export function assertUniqueCapabilityKeys(capabilities: readonly Pick<CapabilityCatalogInput, "key">[]): void {
  capabilities.reduce<Set<string>>((seenKeys, capability) => {
    if (seenKeys.has(capability.key)) {
      throw new Error(DUPLICATE_CAPABILITY_KEY_MESSAGE.replace("{key}", capability.key));
    }

    return new Set([...seenKeys, capability.key]);
  }, new Set<string>());
}

export function getValidatedCapabilityCatalogSeed(): CapabilityCatalogInput[] {
  const parsedCapabilities = capabilityCatalogSeed.map((capability) => capabilityCatalogInputSchema.parse(capability));

  validateCapabilitySignalReferences(parsedCapabilities);
  assertUniqueCapabilityKeys(parsedCapabilities);

  return parsedCapabilities;
}
