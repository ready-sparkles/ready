// Explicit content allowlist: identity, billing, status and relationship fields stay unchanged.
export type ContentField = { column: string; isJson: boolean; isNullable: boolean; default?: unknown };
export type ContentModel = { table: string; keys: string[]; fields: Record<string, ContentField> };
export const contentModels: Record<string, ContentModel> = {
  actionItems: {
    table: "action_items",
    keys: ["id"],
    fields: {
      text: {
        column: "text",
        isJson: false,
        isNullable: false,
      },
    },
  },
  agentMemories: {
    table: "agent_memories",
    keys: ["id"],
    fields: {
      content: {
        column: "content",
        isJson: false,
        isNullable: false,
      },
    },
  },
  agentToolInvocations: {
    table: "agent_tool_invocations",
    keys: ["id"],
    fields: {
      redactedArgs: {
        column: "redacted_args",
        isJson: true,
        isNullable: false,
        default: {},
      },
      redactedResultSummary: {
        column: "redacted_result_summary",
        isJson: true,
        isNullable: false,
        default: {},
      },
    },
  },
  aiWorkflowExecutions: {
    table: "ai_workflow_executions",
    keys: ["id"],
    fields: {
      error: {
        column: "error",
        isJson: false,
        isNullable: true,
      },
      payload: {
        column: "payload",
        isJson: true,
        isNullable: false,
        default: {},
      },
      result: {
        column: "result",
        isJson: true,
        isNullable: false,
        default: {},
      },
    },
  },
  ashbyMeetingAnalyses: {
    table: "ashby_meeting_analyses",
    keys: ["meetingId", "inputHash"],
    fields: {
      result: {
        column: "result",
        isJson: true,
        isNullable: false,
      },
    },
  },
  ashbyReviewActions: {
    table: "ashby_review_actions",
    keys: ["id"],
    fields: {
      result: {
        column: "result",
        isJson: true,
        isNullable: true,
      },
    },
  },
  ashbyReviews: {
    table: "ashby_reviews",
    keys: ["id"],
    fields: {
      review: {
        column: "review",
        isJson: true,
        isNullable: false,
      },
      command: {
        column: "command",
        isJson: true,
        isNullable: true,
      },
    },
  },
  calendarEventPreps: {
    table: "calendar_event_preps",
    keys: ["id"],
    fields: {
      runRefs: {
        column: "run_refs",
        isJson: true,
        isNullable: false,
        default: {},
      },
      eventSnapshot: {
        column: "event_snapshot",
        isJson: true,
        isNullable: false,
        default: {},
      },
      result: {
        column: "result",
        isJson: true,
        isNullable: false,
        default: {},
      },
      error: {
        column: "error",
        isJson: true,
        isNullable: true,
      },
    },
  },
  capabilityWorkflowMessages: {
    table: "capability_workflow_messages",
    keys: ["id"],
    fields: {
      content: {
        column: "content",
        isJson: false,
        isNullable: false,
      },
      metadata: {
        column: "metadata",
        isJson: true,
        isNullable: false,
        default: {},
      },
    },
  },
  capabilityWorkflowRuns: {
    table: "capability_workflow_runs",
    keys: ["id"],
    fields: {
      error: {
        column: "error",
        isJson: false,
        isNullable: true,
      },
      context: {
        column: "context",
        isJson: true,
        isNullable: false,
        default: {},
      },
      plan: {
        column: "plan",
        isJson: true,
        isNullable: false,
        default: {},
      },
      draft: {
        column: "draft",
        isJson: true,
        isNullable: false,
        default: {},
      },
      result: {
        column: "result",
        isJson: true,
        isNullable: false,
        default: {},
      },
    },
  },
  linearTaskReviewItems: {
    table: "linear_task_review_items",
    keys: ["id"],
    fields: {
      reasoning: {
        column: "reasoning",
        isJson: false,
        isNullable: false,
      },
      title: {
        column: "title",
        isJson: false,
        isNullable: false,
      },
      description: {
        column: "description",
        isJson: false,
        isNullable: true,
      },
      syncError: {
        column: "sync_error",
        isJson: false,
        isNullable: true,
      },
      externalIssueTitle: {
        column: "external_issue_title",
        isJson: false,
        isNullable: true,
      },
      externalIssueUrl: {
        column: "external_issue_url",
        isJson: false,
        isNullable: true,
      },
      issueDraft: {
        column: "issue_draft",
        isJson: true,
        isNullable: true,
      },
      targetIssue: {
        column: "target_issue",
        isJson: true,
        isNullable: true,
      },
      duplicateIssues: {
        column: "duplicate_issues",
        isJson: true,
        isNullable: false,
        default: [],
      },
    },
  },
  linearTaskReviewRuns: {
    table: "linear_task_review_runs",
    keys: ["id"],
    fields: {
      error: {
        column: "error",
        isJson: false,
        isNullable: true,
      },
      inputSnapshot: {
        column: "input_snapshot",
        isJson: true,
        isNullable: false,
        default: [],
      },
    },
  },
  meetingAmbientContextItems: {
    table: "meeting_ambient_context_items",
    keys: ["id"],
    fields: {
      canonicalKey: {
        column: "canonical_key",
        isJson: false,
        isNullable: false,
      },
      displayName: {
        column: "display_name",
        isJson: false,
        isNullable: false,
      },
      qualifier: {
        column: "qualifier",
        isJson: false,
        isNullable: true,
      },
      professionalTitle: {
        column: "professional_title",
        isJson: false,
        isNullable: true,
      },
      companyName: {
        column: "company_name",
        isJson: false,
        isNullable: true,
      },
      headquarters: {
        column: "headquarters",
        isJson: false,
        isNullable: true,
      },
      officialWebsite: {
        column: "official_website",
        isJson: false,
        isNullable: true,
      },
      profileUrl: {
        column: "profile_url",
        isJson: false,
        isNullable: true,
      },
      summary: {
        column: "summary",
        isJson: false,
        isNullable: true,
      },
      error: {
        column: "error",
        isJson: false,
        isNullable: true,
      },
      facts: {
        column: "facts",
        isJson: true,
        isNullable: false,
        default: [],
      },
      citations: {
        column: "citations",
        isJson: true,
        isNullable: false,
        default: [],
      },
      facets: {
        column: "facets",
        isJson: true,
        isNullable: false,
        default: [],
      },
    },
  },
  meetingAssets: {
    table: "meeting_assets",
    keys: ["id"],
    fields: {
      transcriptExcerpt: {
        column: "transcript_excerpt",
        isJson: false,
        isNullable: true,
      },
    },
  },
  meetingCapabilityRecommendations: {
    table: "meeting_capability_recommendations",
    keys: ["id"],
    fields: {
      reasoning: {
        column: "reasoning",
        isJson: false,
        isNullable: false,
      },
      signalsMatched: {
        column: "signals_matched",
        isJson: true,
        isNullable: false,
        default: [],
      },
      signalsMissing: {
        column: "signals_missing",
        isJson: true,
        isNullable: false,
        default: [],
      },
      exclusionSignalsChecked: {
        column: "exclusion_signals_checked",
        isJson: true,
        isNullable: false,
        default: [],
      },
      payload: {
        column: "payload",
        isJson: true,
        isNullable: false,
        default: {},
      },
    },
  },
  meetingExtractions: {
    table: "meeting_extractions",
    keys: ["id"],
    fields: {
      meetingTypeReasoning: {
        column: "meeting_type_reasoning",
        isJson: false,
        isNullable: true,
      },
      summaryShort: {
        column: "summary_short",
        isJson: false,
        isNullable: true,
      },
      participants: {
        column: "participants",
        isJson: true,
        isNullable: false,
        default: [],
      },
      summaryBullets: {
        column: "summary_bullets",
        isJson: true,
        isNullable: false,
        default: [],
      },
      decisions: {
        column: "decisions",
        isJson: true,
        isNullable: false,
        default: [],
      },
      actionItems: {
        column: "action_items",
        isJson: true,
        isNullable: false,
        default: [],
      },
      openQuestions: {
        column: "open_questions",
        isJson: true,
        isNullable: false,
        default: [],
      },
      risks: {
        column: "risks",
        isJson: true,
        isNullable: false,
        default: [],
      },
      keyTopics: {
        column: "key_topics",
        isJson: true,
        isNullable: false,
        default: [],
      },
      signals: {
        column: "signals",
        isJson: true,
        isNullable: false,
        default: [],
      },
      failedToolCalls: {
        column: "failed_tool_calls",
        isJson: true,
        isNullable: false,
        default: [],
      },
      highlights: {
        column: "highlights",
        isJson: true,
        isNullable: false,
        default: [],
      },
    },
  },
  meetingLinks: {
    table: "meeting_links",
    keys: ["id"],
    fields: {
      title: {
        column: "title",
        isJson: false,
        isNullable: false,
      },
    },
  },
  meetingLiveTaskCandidateEvidence: {
    table: "meeting_live_task_candidate_evidence",
    keys: ["id"],
    fields: {
      fullSegmentText: {
        column: "full_segment_text",
        isJson: false,
        isNullable: false,
      },
      quote: {
        column: "quote",
        isJson: false,
        isNullable: false,
      },
    },
  },
  meetingLiveTaskCandidates: {
    table: "meeting_live_task_candidates",
    keys: ["id"],
    fields: {
      title: {
        column: "title",
        isJson: false,
        isNullable: false,
      },
      sourceReason: {
        column: "source_reason",
        isJson: false,
        isNullable: false,
      },
      description: {
        column: "description",
        isJson: false,
        isNullable: true,
      },
      dueDateValue: {
        column: "due_date_value",
        isJson: false,
        isNullable: true,
      },
      completion: {
        column: "completion",
        isJson: true,
        isNullable: false,
      },
      sourceQuotes: {
        column: "source_quotes",
        isJson: true,
        isNullable: false,
        default: [],
      },
      unresolvedQuestions: {
        column: "unresolved_questions",
        isJson: true,
        isNullable: false,
        default: [],
      },
    },
  },
  meetingResearchRuns: {
    table: "meeting_research_runs",
    keys: ["id"],
    fields: {
      query: {
        column: "query",
        isJson: false,
        isNullable: false,
      },
      progressLabel: {
        column: "progress_label",
        isJson: false,
        isNullable: true,
      },
      progressDetail: {
        column: "progress_detail",
        isJson: false,
        isNullable: true,
      },
      runRefs: {
        column: "run_refs",
        isJson: true,
        isNullable: false,
        default: {},
      },
      result: {
        column: "result",
        isJson: true,
        isNullable: false,
        default: {},
      },
      error: {
        column: "error",
        isJson: true,
        isNullable: true,
      },
    },
  },
  meetingSuggestedActionRuns: {
    table: "meeting_suggested_action_runs",
    keys: ["id"],
    fields: {
      message: {
        column: "message",
        isJson: false,
        isNullable: true,
      },
      error: {
        column: "error",
        isJson: false,
        isNullable: true,
      },
      steps: {
        column: "steps",
        isJson: true,
        isNullable: false,
        default: [],
      },
    },
  },
  meetingTaskLists: {
    table: "meeting_task_lists",
    keys: ["id"],
    fields: {
      error: {
        column: "error",
        isJson: true,
        isNullable: true,
      },
    },
  },
  meetingTasks: {
    table: "meeting_tasks",
    keys: ["id"],
    fields: {
      title: {
        column: "title",
        isJson: false,
        isNullable: false,
      },
      sourceReason: {
        column: "source_reason",
        isJson: false,
        isNullable: false,
      },
      description: {
        column: "description",
        isJson: false,
        isNullable: true,
      },
      dueDateValue: {
        column: "due_date_value",
        isJson: false,
        isNullable: true,
      },
      sourceQuotes: {
        column: "source_quotes",
        isJson: true,
        isNullable: false,
        default: [],
      },
      externalLinks: {
        column: "external_links",
        isJson: true,
        isNullable: false,
        default: [],
      },
    },
  },
  meetingTrackers: {
    table: "meeting_trackers",
    keys: ["meetingId"],
    fields: {
      items: {
        column: "items",
        isJson: true,
        isNullable: false,
        default: [],
      },
    },
  },
  meetings: {
    table: "meetings",
    keys: ["id"],
    fields: {
      title: {
        column: "title",
        isJson: false,
        isNullable: false,
      },
    },
  },
  memoryEvidence: {
    table: "memory_evidence",
    keys: ["memoryId", "segmentId"],
    fields: {
      quote: {
        column: "quote",
        isJson: false,
        isNullable: false,
      },
    },
  },
  memoryGenerationLedger: {
    table: "memory_generation_ledger",
    keys: ["userId", "meetingId"],
    fields: {
      error: {
        column: "error",
        isJson: false,
        isNullable: true,
      },
    },
  },
  memoryPersonProjections: {
    table: "memory_person_projections",
    keys: ["personId"],
    fields: {
      content: {
        column: "content",
        isJson: true,
        isNullable: false,
      },
    },
  },
  memorySuppressions: {
    table: "memory_suppressions",
    keys: ["sourceId", "factFingerprint"],
    fields: {
      factIdentity: {
        column: "fact_identity",
        isJson: true,
        isNullable: false,
      },
    },
  },
  relationshipMemories: {
    table: "relationship_memories",
    keys: ["id"],
    fields: {
      title: {
        column: "title",
        isJson: false,
        isNullable: false,
      },
      description: {
        column: "description",
        isJson: false,
        isNullable: false,
      },
      candidateSubjectKey: {
        column: "candidate_subject_key",
        isJson: false,
        isNullable: true,
      },
      factIdentity: {
        column: "fact_identity",
        isJson: true,
        isNullable: false,
      },
    },
  },
  slackMeetingReviews: {
    table: "slack_meeting_reviews",
    keys: ["id"],
    fields: {
      review: {
        column: "review",
        isJson: true,
        isNullable: false,
      },
    },
  },
  summaries: {
    table: "summaries",
    keys: ["id"],
    fields: {
      content: {
        column: "content",
        isJson: false,
        isNullable: false,
      },
    },
  },
  transcriptSegments: {
    table: "transcript_segments",
    keys: ["id"],
    fields: {
      content: {
        column: "content",
        isJson: false,
        isNullable: false,
      },
    },
  },
  transcripts: {
    table: "transcripts",
    keys: ["id"],
    fields: {
      metadata: {
        column: "metadata",
        isJson: true,
        isNullable: false,
        default: {},
      },
    },
  },
  voiceWebResearchRuns: {
    table: "voice_web_research_runs",
    keys: ["id"],
    fields: {
      query: {
        column: "query",
        isJson: false,
        isNullable: false,
      },
      queryKey: {
        column: "query_key",
        isJson: false,
        isNullable: false,
      },
      runRefs: {
        column: "run_refs",
        isJson: true,
        isNullable: false,
        default: {},
      },
      progress: {
        column: "progress",
        isJson: true,
        isNullable: false,
        default: {},
      },
      result: {
        column: "result",
        isJson: true,
        isNullable: false,
        default: {},
      },
      error: {
        column: "error",
        isJson: true,
        isNullable: true,
      },
    },
  },
  workspaceTaskSections: {
    table: "workspace_task_sections",
    keys: ["id"],
    fields: {
      title: {
        column: "title",
        isJson: false,
        isNullable: false,
      },
    },
  },
  workspaceTasks: {
    table: "workspace_tasks",
    keys: ["id"],
    fields: {
      title: {
        column: "title",
        isJson: false,
        isNullable: false,
      },
      description: {
        column: "description",
        isJson: false,
        isNullable: true,
      },
      dueDateValue: {
        column: "due_date_value",
        isJson: false,
        isNullable: true,
      },
    },
  },
};

export const modelRelations: Record<string, Record<string, string>> = {
  acquisitionPayments: {
    users: "users",
    workspaces: "workspaces",
  },
  actionItems: {
    meetings: "meetings",
  },
  adminUserPlanChanges: {
    usersAdminUserPlanChangesActorUserIdTousers: "users",
    usersAdminUserPlanChangesTargetUserIdTousers: "users",
  },
  agentConnectorSecrets: {
    agentConnectors: "agentConnectors",
  },
  agentConnectors: {
    agentConnectorSecrets: "agentConnectorSecrets",
    agentProfiles: "agentProfiles",
    users: "users",
    agentToolInvocations: "agentToolInvocations",
    calendarEventPreps: "calendarEventPreps",
    calendarReadyLinks: "calendarReadyLinks",
    calendarSyncSubscriptions: "calendarSyncSubscriptions",
    linearTaskReviewRuns: "linearTaskReviewRuns",
    pendingGoogleAddonCalendarCredentials: "pendingGoogleAddonCalendarCredentials",
  },
  agentMemories: {
    agentProfiles: "agentProfiles",
    users: "users",
  },
  agentProfiles: {
    agentConnectors: "agentConnectors",
    agentMemories: "agentMemories",
    users: "users",
    agentToolInvocations: "agentToolInvocations",
    agentToolPolicies: "agentToolPolicies",
    meetingResearchRuns: "meetingResearchRuns",
    meetingTurns: "meetingTurns",
    transcriptSegments: "transcriptSegments",
    voiceWebResearchRuns: "voiceWebResearchRuns",
  },
  agentToolInvocations: {
    agentProfiles: "agentProfiles",
    usersAgentToolInvocationsConfirmationActorUserIdTousers: "users",
    agentConnectors: "agentConnectors",
    meetings: "meetings",
    usersAgentToolInvocationsUserIdTousers: "users",
  },
  agentToolPolicies: {
    agentProfiles: "agentProfiles",
  },
  aiCreditReservations: {
    workspaces: "workspaces",
    users: "users",
    aiCreditUsageEvents: "aiCreditUsageEvents",
  },
  aiCreditUsageEvents: {
    aiCreditReservations: "aiCreditReservations",
    aiWorkflowExecutions: "aiWorkflowExecutions",
    meetings: "meetings",
    users: "users",
    capabilityWorkflowRuns: "capabilityWorkflowRuns",
    workspaces: "workspaces",
  },
  aiWorkflowExecutions: {
    aiCreditUsageEvents: "aiCreditUsageEvents",
    meetingExtractions: "meetingExtractions",
    meetings: "meetings",
    usageEvents: "usageEvents",
  },
  ashbyCandidateEmailLookups: {
    workspaces: "workspaces",
  },
  ashbyMeetingAnalyses: {
    meetings: "meetings",
  },
  ashbyMemberConnections: {
    users: "users",
    workspaces: "workspaces",
  },
  ashbyReviewActions: {
    meetings: "meetings",
    workspaces: "workspaces",
  },
  ashbyReviews: {
    meetings: "meetings",
    users: "users",
    workspaces: "workspaces",
  },
  assignedTaskPlacements: {
    usersAssignedTaskPlacementsAssigneeUserIdTousers: "users",
    workspaceTaskSections: "workspaceTaskSections",
    usersAssignedTaskPlacementsUpdatedByUserIdTousers: "users",
    workspaces: "workspaces",
  },
  billingCustomers: {
    users: "users",
  },
  billingSubscriptions: {
    users: "users",
    workspaces: "workspaces",
  },
  calendarEventPreps: {
    agentConnectors: "agentConnectors",
    users: "users",
  },
  calendarReadyLinks: {
    agentConnectors: "agentConnectors",
    meetingLinks: "meetingLinks",
    users: "users",
  },
  calendarSyncSubscriptions: {
    agentConnectors: "agentConnectors",
    users: "users",
  },
  capabilityCatalog: {
    capabilityWorkflowRuns: "capabilityWorkflowRuns",
    meetingCapabilityRecommendations: "meetingCapabilityRecommendations",
    userCapabilityPreferences: "userCapabilityPreferences",
  },
  capabilityWorkflowMessages: {
    capabilityWorkflowRuns: "capabilityWorkflowRuns",
  },
  capabilityWorkflowRuns: {
    aiCreditUsageEvents: "aiCreditUsageEvents",
    capabilityWorkflowMessages: "capabilityWorkflowMessages",
    capabilityCatalog: "capabilityCatalog",
    meetings: "meetings",
    meetingCapabilityRecommendations: "meetingCapabilityRecommendations",
    usageEvents: "usageEvents",
  },
  creditGrants: {
    users: "users",
    workspaces: "workspaces",
  },
  dataDeletionRequests: {
    users: "users",
  },
  googleAddonConferences: {
    meetingLinks: "meetingLinks",
    users: "users",
  },
  guestAuthSessions: {
    meetingJoinRequests: "meetingJoinRequests",
    usersGuestAuthSessionsLinkedToUserIdTousers: "users",
    meetings: "meetings",
    meetingLinks: "meetingLinks",
    usersGuestAuthSessionsUserIdTousers: "users",
  },
  guestBrowserIdentities: {
    users: "users",
    guestBrowserUsers: "guestBrowserUsers",
  },
  guestBrowserUsers: {
    guestBrowserIdentities: "guestBrowserIdentities",
    users: "users",
  },
  guestMemoryAccountLinks: {
    usersGuestMemoryAccountLinksAccountUserIdTousers: "users",
    usersGuestMemoryAccountLinksGuestUserIdTousers: "users",
  },
  linearTaskReviewItems: {
    linearTaskReviewRuns: "linearTaskReviewRuns",
  },
  linearTaskReviewRuns: {
    linearTaskReviewItems: "linearTaskReviewItems",
    agentConnectors: "agentConnectors",
    meetings: "meetings",
    meetingTaskLists: "meetingTaskLists",
    users: "users",
  },
  meetingAmbientContextCursors: {
    transcriptSegments: "transcriptSegments",
    meetings: "meetings",
  },
  meetingAmbientContextItems: {
    meetings: "meetings",
  },
  meetingAssets: {
    meetings: "meetings",
  },
  meetingAttendanceIntervals: {
    meetings: "meetings",
    users: "users",
  },
  meetingAttendeeWorkspaces: {
    meetings: "meetings",
    users: "users",
    workspaces: "workspaces",
  },
  meetingCapabilityRecommendations: {
    capabilityWorkflowRuns: "capabilityWorkflowRuns",
    capabilityCatalog: "capabilityCatalog",
    meetingExtractions: "meetingExtractions",
    meetings: "meetings",
    meetingResearchRuns: "meetingResearchRuns",
  },
  meetingExtractions: {
    aiWorkflowExecutions: "aiWorkflowExecutions",
    meetingCapabilityRecommendations: "meetingCapabilityRecommendations",
    meetings: "meetings",
  },
  meetingJoinRequests: {
    guestAuthSessions: "guestAuthSessions",
    usersMeetingJoinRequestsDecidedByUserIdTousers: "users",
    meetings: "meetings",
    meetingLinks: "meetingLinks",
    usersMeetingJoinRequestsUserIdTousers: "users",
  },
  meetingLinkCallIns: {
    meetings: "meetings",
    meetingLinks: "meetingLinks",
  },
  meetingLinks: {
    calendarReadyLinks: "calendarReadyLinks",
    googleAddonConferences: "googleAddonConferences",
    guestAuthSessions: "guestAuthSessions",
    meetingJoinRequests: "meetingJoinRequests",
    meetingLinkCallIns: "meetingLinkCallIns",
    users: "users",
    workspaces: "workspaces",
    meetings: "meetings",
  },
  meetingLiveTaskCandidateEvidence: {
    meetingLiveTaskCandidates: "meetingLiveTaskCandidates",
    users: "users",
    transcriptSegments: "transcriptSegments",
  },
  meetingLiveTaskCandidates: {
    meetingLiveTaskCandidateEvidence: "meetingLiveTaskCandidateEvidence",
    meetingTasks: "meetingTasks",
    meetings: "meetings",
    users: "users",
  },
  meetingLiveTaskCursors: {
    transcriptSegments: "transcriptSegments",
    meetings: "meetings",
  },
  meetingParticipants: {
    meetings: "meetings",
    users: "users",
  },
  meetingResearchRuns: {
    agentProfiles: "agentProfiles",
    meetings: "meetings",
    meetingCapabilityRecommendations: "meetingCapabilityRecommendations",
    users: "users",
  },
  meetingSuggestedActionRuns: {
    meetings: "meetings",
  },
  meetingTaskLatencyObservations: {
    meetings: "meetings",
    meetingTasks: "meetingTasks",
  },
  meetingTaskLists: {
    linearTaskReviewRuns: "linearTaskReviewRuns",
    meetings: "meetings",
    meetingTasks: "meetingTasks",
  },
  meetingTasks: {
    meetingLiveTaskCandidates: "meetingLiveTaskCandidates",
    meetingTaskLatencyObservations: "meetingTaskLatencyObservations",
    meetings: "meetings",
    usersMeetingTasksOwnerUserIdTousers: "users",
    usersMeetingTasksStatusActorUserIdTousers: "users",
    meetingTaskLists: "meetingTaskLists",
  },
  meetingFinalizationClaims: {
    meetings: "meetings",
  },
  meetingTrackers: {
    meetings: "meetings",
  },
  meetingTrialSlots: {
    meetings: "meetings",
    users: "users",
    workspaces: "workspaces",
  },
  meetingTurns: {
    agentProfiles: "agentProfiles",
    meetings: "meetings",
    users: "users",
    transcriptSegments: "transcriptSegments",
  },
  meetings: {
    actionItems: "actionItems",
    agentToolInvocations: "agentToolInvocations",
    aiCreditUsageEvents: "aiCreditUsageEvents",
    aiWorkflowExecutions: "aiWorkflowExecutions",
    ashbyMeetingAnalyses: "ashbyMeetingAnalyses",
    ashbyReviewActions: "ashbyReviewActions",
    ashbyReviews: "ashbyReviews",
    capabilityWorkflowRuns: "capabilityWorkflowRuns",
    guestAuthSessions: "guestAuthSessions",
    linearTaskReviewRuns: "linearTaskReviewRuns",
    meetingAmbientContextCursors: "meetingAmbientContextCursors",
    meetingAmbientContextItems: "meetingAmbientContextItems",
    meetingAssets: "meetingAssets",
    meetingAttendanceIntervals: "meetingAttendanceIntervals",
    meetingAttendeeWorkspaces: "meetingAttendeeWorkspaces",
    meetingCapabilityRecommendations: "meetingCapabilityRecommendations",
    meetingExtractions: "meetingExtractions",
    meetingJoinRequests: "meetingJoinRequests",
    meetingLinkCallIns: "meetingLinkCallIns",
    meetingLiveTaskCandidates: "meetingLiveTaskCandidates",
    meetingLiveTaskCursors: "meetingLiveTaskCursors",
    meetingParticipants: "meetingParticipants",
    meetingResearchRuns: "meetingResearchRuns",
    meetingSuggestedActionRuns: "meetingSuggestedActionRuns",
    meetingTaskLatencyObservations: "meetingTaskLatencyObservations",
    meetingTaskLists: "meetingTaskLists",
    meetingTasks: "meetingTasks",
    meetingFinalizationClaims: "meetingFinalizationClaims",
    meetingTrackers: "meetingTrackers",
    meetingTrialSlots: "meetingTrialSlots",
    meetingTurns: "meetingTurns",
    usersMeetingsConfidentialityUpdatedByUserIdTousers: "users",
    usersMeetingsCreatedByUserIdTousers: "users",
    meetingLinks: "meetingLinks",
    workspaces: "workspaces",
    memoryGenerationLedger: "memoryGenerationLedger",
    memorySources: "memorySources",
    slackMeetingDeliveries: "slackMeetingDeliveries",
    slackMeetingReviews: "slackMeetingReviews",
    summaries: "summaries",
    transcripts: "transcripts",
    usageEvents: "usageEvents",
    voiceWebResearchRuns: "voiceWebResearchRuns",
  },
  memoryEvidence: {
    relationshipMemories: "relationshipMemories",
    transcriptSegments: "transcriptSegments",
  },
  memoryGenerationLedger: {
    meetings: "meetings",
    memorySources: "memorySources",
    users: "users",
  },
  memoryInteractions: {
    memoryPeople: "memoryPeople",
    memorySources: "memorySources",
  },
  memoryLegacySuppressions: {
    memorySources: "memorySources",
  },
  memoryPeople: {
    memoryInteractions: "memoryInteractions",
    users: "users",
    workspaces: "workspaces",
    memoryPersonIdentitiesMemoryPersonIdentitiesPersonIdTomemoryPeople: "memoryPersonIdentities",
    memoryPersonIdentitiesMemoryPersonIdentitiesPersonIdUserIdWorkspaceIdTomemoryPeople: "memoryPersonIdentities",
    memoryPersonNames: "memoryPersonNames",
    memoryPersonProjections: "memoryPersonProjections",
    memoryPersonRedirectsMemoryPersonRedirectsPersonIdTomemoryPeople: "memoryPersonRedirects",
    memoryPersonRedirectsMemoryPersonRedirectsTargetPersonIdTomemoryPeople: "memoryPersonRedirects",
    relationshipMemories: "relationshipMemories",
  },
  memoryPersonIdentities: {
    memoryPeopleMemoryPersonIdentitiesPersonIdTomemoryPeople: "memoryPeople",
    memoryPeopleMemoryPersonIdentitiesPersonIdUserIdWorkspaceIdTomemoryPeople: "memoryPeople",
    users: "users",
    workspaces: "workspaces",
  },
  memoryPersonNames: {
    users: "users",
    memoryPeople: "memoryPeople",
    memorySources: "memorySources",
  },
  memoryPersonProjections: {
    memoryPeople: "memoryPeople",
  },
  memoryPersonRedirects: {
    memoryPeopleMemoryPersonRedirectsPersonIdTomemoryPeople: "memoryPeople",
    memoryPeopleMemoryPersonRedirectsTargetPersonIdTomemoryPeople: "memoryPeople",
  },
  memoryPreferences: {
    users: "users",
    workspaces: "workspaces",
    memorySensitivityHistory: "memorySensitivityHistory",
  },
  memorySensitivityHistory: {
    memoryPreferences: "memoryPreferences",
  },
  memorySources: {
    memoryGenerationLedger: "memoryGenerationLedger",
    memoryInteractions: "memoryInteractions",
    memoryLegacySuppressions: "memoryLegacySuppressions",
    memoryPersonNames: "memoryPersonNames",
    meetings: "meetings",
    users: "users",
    workspaces: "workspaces",
    memorySuppressions: "memorySuppressions",
    relationshipMemories: "relationshipMemories",
  },
  memorySuppressions: {
    memorySources: "memorySources",
  },
  memorySyncChanges: {
    memorySyncHeads: "memorySyncHeads",
  },
  memorySyncHeads: {
    memorySyncChanges: "memorySyncChanges",
    users: "users",
    workspaces: "workspaces",
  },
  pendingGoogleAddonCalendarCredentials: {
    agentConnectors: "agentConnectors",
  },
  personalTaskClearances: {
    users: "users",
    workspaces: "workspaces",
  },
  personalTaskItemClearances: {
    users: "users",
    workspaces: "workspaces",
  },
  privateBetaWaitlistEntries: {
    users: "users",
  },
  relationshipMemories: {
    memoryEvidence: "memoryEvidence",
    memoryPeople: "memoryPeople",
    memorySources: "memorySources",
  },
  slackDeliveryConfigs: {
    users: "users",
  },
  slackMeetingDeliveries: {
    meetings: "meetings",
    users: "users",
  },
  slackMeetingReviews: {
    meetings: "meetings",
    users: "users",
    slackReviewDeliveries: "slackReviewDeliveries",
  },
  slackReviewDeliveries: {
    slackMeetingReviews: "slackMeetingReviews",
  },
  summaries: {
    meetings: "meetings",
  },
  transcriptSegments: {
    meetingAmbientContextCursors: "meetingAmbientContextCursors",
    meetingLiveTaskCandidateEvidence: "meetingLiveTaskCandidateEvidence",
    meetingLiveTaskCursors: "meetingLiveTaskCursors",
    memoryEvidence: "memoryEvidence",
    usersTranscriptSegmentsAgentOwnerUserIdTousers: "users",
    agentProfiles: "agentProfiles",
    meetingTurns: "meetingTurns",
    usersTranscriptSegmentsSpeakerUserIdTousers: "users",
    transcripts: "transcripts",
  },
  transcripts: {
    transcriptSegments: "transcriptSegments",
    meetings: "meetings",
  },
  usageEvents: {
    aiWorkflowExecutions: "aiWorkflowExecutions",
    meetings: "meetings",
    users: "users",
    capabilityWorkflowRuns: "capabilityWorkflowRuns",
  },
  userAcquisition: {
    users: "users",
    workspaces: "workspaces",
  },
  userAuthAccounts: {
    users: "users",
  },
  userCapabilityPreferences: {
    capabilityCatalog: "capabilityCatalog",
    users: "users",
  },
  userMediaPreferences: {
    users: "users",
  },
  users: {
    aiCreditReservations: "aiCreditReservations",
    acquisitionPayments: "acquisitionPayments",
    adminUserPlanChangesAdminUserPlanChangesActorUserIdTousers: "adminUserPlanChanges",
    adminUserPlanChangesAdminUserPlanChangesTargetUserIdTousers: "adminUserPlanChanges",
    agentConnectors: "agentConnectors",
    agentMemories: "agentMemories",
    agentProfiles: "agentProfiles",
    agentToolInvocationsAgentToolInvocationsConfirmationActorUserIdTousers: "agentToolInvocations",
    agentToolInvocationsAgentToolInvocationsUserIdTousers: "agentToolInvocations",
    aiCreditUsageEvents: "aiCreditUsageEvents",
    ashbyMemberConnections: "ashbyMemberConnections",
    ashbyReviews: "ashbyReviews",
    assignedTaskPlacementsAssignedTaskPlacementsAssigneeUserIdTousers: "assignedTaskPlacements",
    assignedTaskPlacementsAssignedTaskPlacementsUpdatedByUserIdTousers: "assignedTaskPlacements",
    billingCustomers: "billingCustomers",
    billingSubscriptions: "billingSubscriptions",
    calendarEventPreps: "calendarEventPreps",
    calendarReadyLinks: "calendarReadyLinks",
    calendarSyncSubscriptions: "calendarSyncSubscriptions",
    creditGrants: "creditGrants",
    dataDeletionRequests: "dataDeletionRequests",
    googleAddonConferences: "googleAddonConferences",
    guestAuthSessionsGuestAuthSessionsLinkedToUserIdTousers: "guestAuthSessions",
    guestAuthSessionsGuestAuthSessionsUserIdTousers: "guestAuthSessions",
    guestBrowserIdentities: "guestBrowserIdentities",
    guestBrowserUsers: "guestBrowserUsers",
    guestMemoryAccountLinksGuestMemoryAccountLinksAccountUserIdTousers: "guestMemoryAccountLinks",
    guestMemoryAccountLinksGuestMemoryAccountLinksGuestUserIdTousers: "guestMemoryAccountLinks",
    linearTaskReviewRuns: "linearTaskReviewRuns",
    meetingAttendanceIntervals: "meetingAttendanceIntervals",
    meetingAttendeeWorkspaces: "meetingAttendeeWorkspaces",
    meetingJoinRequestsMeetingJoinRequestsDecidedByUserIdTousers: "meetingJoinRequests",
    meetingJoinRequestsMeetingJoinRequestsUserIdTousers: "meetingJoinRequests",
    meetingLinks: "meetingLinks",
    meetingLiveTaskCandidateEvidence: "meetingLiveTaskCandidateEvidence",
    meetingLiveTaskCandidates: "meetingLiveTaskCandidates",
    meetingParticipants: "meetingParticipants",
    meetingResearchRuns: "meetingResearchRuns",
    meetingTasksMeetingTasksOwnerUserIdTousers: "meetingTasks",
    meetingTasksMeetingTasksStatusActorUserIdTousers: "meetingTasks",
    meetingTrialSlots: "meetingTrialSlots",
    meetingTurns: "meetingTurns",
    meetingsMeetingsConfidentialityUpdatedByUserIdTousers: "meetings",
    meetingsMeetingsCreatedByUserIdTousers: "meetings",
    memoryGenerationLedger: "memoryGenerationLedger",
    memoryPeople: "memoryPeople",
    memoryPersonIdentities: "memoryPersonIdentities",
    memoryPersonNames: "memoryPersonNames",
    memoryPreferences: "memoryPreferences",
    memorySources: "memorySources",
    memorySyncHeads: "memorySyncHeads",
    personalTaskClearances: "personalTaskClearances",
    personalTaskItemClearances: "personalTaskItemClearances",
    privateBetaWaitlistEntries: "privateBetaWaitlistEntries",
    slackDeliveryConfigs: "slackDeliveryConfigs",
    slackMeetingDeliveries: "slackMeetingDeliveries",
    slackMeetingReviews: "slackMeetingReviews",
    transcriptSegmentsTranscriptSegmentsAgentOwnerUserIdTousers: "transcriptSegments",
    transcriptSegmentsTranscriptSegmentsSpeakerUserIdTousers: "transcriptSegments",
    usageEvents: "usageEvents",
    userAcquisition: "userAcquisition",
    userAuthAccounts: "userAuthAccounts",
    userCapabilityPreferences: "userCapabilityPreferences",
    userMediaPreferences: "userMediaPreferences",
    workspacesUsersActiveWorkspaceIdToworkspaces: "workspaces",
    voiceWebResearchRuns: "voiceWebResearchRuns",
    workspaceAshbyIntegrations: "workspaceAshbyIntegrations",
    workspaceAuditEvents: "workspaceAuditEvents",
    workspaceInvitationsWorkspaceInvitationsAcceptedByUserIdTousers: "workspaceInvitations",
    workspaceInvitationsWorkspaceInvitationsInvitedByUserIdTousers: "workspaceInvitations",
    workspaceMemberships: "workspaceMemberships",
    workspaceTaskSectionsWorkspaceTaskSectionsCreatedByUserIdTousers: "workspaceTaskSections",
    workspaceTaskSectionsWorkspaceTaskSectionsUpdatedByUserIdTousers: "workspaceTaskSections",
    workspaceTasksWorkspaceTasksAssigneeUserIdTousers: "workspaceTasks",
    workspaceTasksWorkspaceTasksCreatedByUserIdTousers: "workspaceTasks",
    workspaceTasksWorkspaceTasksUpdatedByUserIdTousers: "workspaceTasks",
    workspacesWorkspacesCreatedByUserIdTousers: "workspaces",
  },
  voiceWebResearchRuns: {
    agentProfiles: "agentProfiles",
    meetings: "meetings",
    users: "users",
  },
  workspaceAshbyIntegrations: {
    users: "users",
    workspaces: "workspaces",
  },
  workspaceAuditEvents: {
    users: "users",
    workspaces: "workspaces",
  },
  workspaceBillingCustomers: {
    workspaces: "workspaces",
  },
  workspaceInvitations: {
    usersWorkspaceInvitationsAcceptedByUserIdTousers: "users",
    usersWorkspaceInvitationsInvitedByUserIdTousers: "users",
    workspaces: "workspaces",
  },
  workspaceMemberships: {
    users: "users",
    workspaces: "workspaces",
  },
  workspaceTaskSections: {
    assignedTaskPlacements: "assignedTaskPlacements",
    usersWorkspaceTaskSectionsCreatedByUserIdTousers: "users",
    usersWorkspaceTaskSectionsUpdatedByUserIdTousers: "users",
    workspaces: "workspaces",
  },
  workspaceTasks: {
    usersWorkspaceTasksAssigneeUserIdTousers: "users",
    usersWorkspaceTasksCreatedByUserIdTousers: "users",
    usersWorkspaceTasksUpdatedByUserIdTousers: "users",
    workspaces: "workspaces",
  },
  workspaces: {
    aiCreditReservations: "aiCreditReservations",
    acquisitionPayments: "acquisitionPayments",
    aiCreditUsageEvents: "aiCreditUsageEvents",
    ashbyCandidateEmailLookups: "ashbyCandidateEmailLookups",
    ashbyMemberConnections: "ashbyMemberConnections",
    ashbyReviewActions: "ashbyReviewActions",
    ashbyReviews: "ashbyReviews",
    assignedTaskPlacements: "assignedTaskPlacements",
    billingSubscriptions: "billingSubscriptions",
    creditGrants: "creditGrants",
    meetingAttendeeWorkspaces: "meetingAttendeeWorkspaces",
    meetingLinks: "meetingLinks",
    meetingTrialSlots: "meetingTrialSlots",
    meetings: "meetings",
    memoryPeople: "memoryPeople",
    memoryPersonIdentities: "memoryPersonIdentities",
    memoryPreferences: "memoryPreferences",
    memorySources: "memorySources",
    memorySyncHeads: "memorySyncHeads",
    personalTaskClearances: "personalTaskClearances",
    personalTaskItemClearances: "personalTaskItemClearances",
    userAcquisition: "userAcquisition",
    usersUsersActiveWorkspaceIdToworkspaces: "users",
    workspaceAshbyIntegrations: "workspaceAshbyIntegrations",
    workspaceAuditEvents: "workspaceAuditEvents",
    workspaceBillingCustomers: "workspaceBillingCustomers",
    workspaceInvitations: "workspaceInvitations",
    workspaceMemberships: "workspaceMemberships",
    workspaceTaskSections: "workspaceTaskSections",
    workspaceTasks: "workspaceTasks",
    usersWorkspacesCreatedByUserIdTousers: "users",
  },
};
