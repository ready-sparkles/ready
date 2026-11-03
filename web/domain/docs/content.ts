type DocsArticleSection = {
  title: string;
  kind?: "notes" | "steps";
  items: string[];
};

type DocsArticle = {
  slug: string;
  title: string;
  navTitle?: string;
  description: string;
  category: string;
  notice?: { title: string; description: string };
  sections: DocsArticleSection[];
};

type DocsCategory = {
  title: string;
  description: string;
  articles: string[];
};

export const docsArticles: DocsArticle[] = [
  {
    slug: "getting-started",
    title: "Get started with Ready",
    navTitle: "Start",
    description: "Set up your workspace, start a meeting, and find your follow-up work.",
    category: "Start",
    sections: [
      {
        title: "Your first meeting",
        kind: "steps",
        items: [
          "Go to ready.app and choose Sign in, then continue with Google or Microsoft.",
          "Open Settings from your profile menu. Connect your calendar under Calendars to see upcoming events.",
          "Choose New in the sidebar to start a Ready meeting. Share the join link with your guests.",
          "After the meeting, open Past to review notes and tasks.",
        ],
      },
      {
        title: "Find your way around",
        items: [
          "Meetings: Upcoming shows your calendar events. Past holds previous meetings and their notes.",
          "Tasks: Mine shows your tasks, Others shows tasks outside your list, and Done shows completed work.",
          "Memory: All holds your memories. People groups them by person. These views appear when Memory is available.",
          "Profile menu: Open Settings, switch workspaces, create a workspace, or log out.",
        ],
      },
    ],
  },
  {
    slug: "connect-calendar",
    title: "Connect your calendar",
    navTitle: "Connect",
    description: "See upcoming meetings and prepare for them with Google Calendar or Outlook Calendar.",
    category: "Calendar",
    sections: [
      {
        title: "Connect an account",
        kind: "steps",
        items: [
          "Open your profile menu, then Settings → Calendars.",
          "Choose Connect calendar, then Google Calendar or Outlook Calendar.",
          "Sign in to the calendar account and approve the requested access.",
          "Return to Ready. Check that the account appears, then open Upcoming.",
        ],
      },
      {
        title: "Manage the connection",
        items: [
          "You can connect more than one calendar account and mark each as work or personal.",
          "Ready uses event details, times, and attendees to show your schedule and prepare meeting context.",
          "Adding a Ready link requires permission to edit the calendar event.",
          "The Google Calendar add-on is a separate connection. Installing it does not connect your calendar to the Ready workspace.",
        ],
      },
    ],
  },
  {
    slug: "google-calendar-addon",
    title: "Add Ready to Google Calendar",
    navTitle: "Add-on",
    description: "Create Ready meeting links directly inside your calendar events.",
    category: "Calendar",
    sections: [
      {
        title: "Add a meeting link",
        kind: "steps",
        items: [
          "Install Ready from Google Workspace Marketplace for the Google account you use with Calendar.",
          "In Google Calendar, create an event or open one you can edit.",
          "Open the video conferencing options and choose Ready Meeting.",
          "Approve any authorization prompt. Wait for the Ready join link to appear.",
          "Save the event to share the meeting details with your guests.",
        ],
      },
      {
        title: "Account and access",
        items: [
          "The add-on creates or finds your Ready account using your Google identity. You do not need a separate Ready browser sign-in.",
          "AI features follow the Ready workspace’s plan and available usage.",
          "If Ready Meeting is missing, reload Calendar and check that the add-on is installed for the active Google account.",
          "If Google shows Authorize, complete that step before trying again.",
        ],
      },
    ],
  },
  {
    slug: "prepare-for-meetings",
    title: "Prepare for a meeting",
    navTitle: "Prep",
    description: "Review the context before you join.",
    category: "Calendar",
    sections: [
      {
        title: "Open meeting prep",
        kind: "steps",
        items: [
          "Connect your calendar in Settings → Calendars.",
          "Open Upcoming and select a meeting.",
          "Review the available prep, then join from the meeting link.",
        ],
      },
      {
        title: "What to expect",
        items: [
          "Prep depends on your plan, connected accounts, and the information Ready can access.",
          "Check important details against the calendar event or original source. AI can miss context or make mistakes.",
        ],
      },
    ],
  },
  {
    slug: "join-meeting",
    title: "Join a meeting",
    navTitle: "Join",
    description: "Open the link, check your devices, and join from your browser.",
    category: "Meetings",
    sections: [
      {
        title: "Join from a link",
        kind: "steps",
        items: [
          "Open the Ready link from your invitation or calendar event.",
          "If you are joining as a guest, enter your name.",
          "Allow microphone and camera access. Check your devices on the preview screen.",
          "Choose Join. If host approval is needed, wait for the host to admit you.",
        ],
      },
      {
        title: "Before you enter",
        items: [
          "You can turn your microphone and camera off before joining.",
          "Background blur is available on supported devices and browsers.",
          "If device access is blocked, allow it in your browser’s site settings for ready.app.",
          "When dial-in details are available, use the phone number and PIN shown in the meeting details.",
        ],
      },
    ],
  },
  {
    slug: "host-live-meeting",
    title: "Host a meeting",
    navTitle: "Host",
    description: "Invite people, manage the call, and choose who can access it.",
    category: "Meetings",
    sections: [
      {
        title: "Start and invite",
        kind: "steps",
        items: [
          "Choose New in the sidebar, or open the Ready link for a scheduled meeting.",
          "Check your microphone and camera, then join.",
          "Copy the join link from meeting details and send it to your guests.",
          "Admit waiting guests when their requests appear. Admission controls are available to meeting moderators.",
        ],
      },
      {
        title: "During the call",
        items: [
          "Use the microphone and camera buttons to turn devices on or off.",
          "Share a tab, window, or screen with the screen-sharing control.",
          "Use captions to follow the conversation. When you’re alone, use voice chat with Ready to talk with your agent.",
        ],
      },
      {
        title: "The meeting lock",
        items: [
          "The lock next to the camera button controls who can see the meeting and its notes.",
          "Locked: The meeting is confidential. Only participants can access it.",
          "Unlocked: The meeting is visible to your workspace, including members who did not attend.",
          "The organizer or a participating workspace admin can change the lock during the meeting. Guests cannot change it.",
          "Internal one-to-one meetings are always locked and cannot be unlocked.",
          "Locking does not stop recording, transcription, or AI processing. Guest admission is managed separately through the waiting room.",
        ],
      },
      {
        title: "End the meeting",
        items: [
          "Leave meeting exits your connection. Hosts can use End meeting for all to end the meeting for everyone.",
          "Final notes may take time to finish after the meeting ends.",
        ],
      },
    ],
  },
  {
    slug: "use-agent-help",
    title: "Voice chat with Ready",
    navTitle: "Voice",
    description: "Talk with your Ready agent when you’re alone in the meeting.",
    category: "Meetings",
    sections: [
      {
        title: "Start a conversation",
        kind: "steps",
        items: [
          "Join a meeting where the Ready assistant is available and you’re the only person in the room.",
          "Select the speech-wave icon to start voice chat with Ready.",
          "Speak naturally. Ready responds to the participant who started voice chat with Ready.",
          "Select the icon again to end the voice conversation.",
        ],
      },
      {
        title: "Get useful answers",
        items: [
          "Ask about the meeting, request a web search, or use tools available through connected apps.",
          "Longer tasks can show progress, results, and sources in a side panel.",
          "Review proposed changes before approving them. Check important answers against their sources.",
        ],
      },
    ],
  },
  {
    slug: "meeting-output",
    title: "Review meeting notes",
    navTitle: "Notes",
    description: "Find the summary, transcript, and tasks from a past meeting.",
    category: "Follow-up",
    sections: [
      {
        title: "Find your notes",
        kind: "steps",
        items: [
          "Open Past in the sidebar and select a meeting.",
          "Read the notes and open the transcript when you need the original wording.",
          "Review each task’s title and assignee. Edit tasks or mark them complete as needed.",
          "Use the meeting menu to copy the transcript or choose Copy summary & tasks.",
        ],
      },
      {
        title: "If notes are missing",
        items: [
          "Notes and tasks can finish at different times. Wait for processing to complete, then refresh if needed.",
          "Check that you are in the right workspace and have access to the meeting’s notes.",
          "Very short meetings or meetings without enough transcript content may not produce notes. Plan limits can also affect availability.",
        ],
      },
      {
        title: "Guest access",
        items: [
          "Guests who joined can see read-only notes and tasks after leaving, as the output becomes ready.",
          "Guests can create an account to save their meeting output.",
          "Guest notes require access from the joined guest session. The link is not a public sharing link.",
        ],
      },
    ],
  },
  {
    slug: "tasks",
    title: "Manage your tasks",
    navTitle: "Tasks",
    description: "Track your work and follow up with others in the current workspace.",
    category: "Follow-up",
    sections: [
      {
        title: "Choose a list",
        items: [
          "Mine: Your open tasks.",
          "Others: Open tasks assigned to other people, plus unassigned work you can access.",
          "Done: Completed tasks.",
          "Switching workspaces changes the tasks you see.",
        ],
      },
      {
        title: "Work with tasks",
        items: [
          "Create a task in Mine for your own work, or in Others for unassigned workspace work.",
          "Select a task title to edit it when allowed. Use the assignee control to change who owns it when available.",
          "Use the check circle to complete a task or reopen it.",
          "Open a task’s meeting link to see the conversation it came from.",
          "Use search to find a task and sections to organize your Mine list.",
        ],
      },
    ],
  },
  {
    slug: "memory",
    title: "Use Memory",
    navTitle: "Memory",
    description: "Remember decisions, commitments, and useful context about the people you meet.",
    category: "Follow-up",
    notice: {
      title: "Personal and private",
      description: "Only you can view your memories. They are not shared with other participants or workspace members.",
    },
    sections: [
      {
        title: "Find a memory",
        items: [
          "Open All under Memory to search or filter your memories.",
          "Open a memory and choose View transcript to check the supporting conversation.",
          "Open People to see a person’s summary, past meetings, and Where things stand.",
          "Check important details in the transcript. A plan or promise does not mean the work was completed.",
        ],
      },
      {
        title: "What gets remembered",
        items: [
          "Memory must be available for your workspace and plan. Memories come from eligible new meetings that you can access notes for.",
          "Older meetings are not backfilled. Solo AI conversations are not included, and some meetings produce no memories.",
          "Each workspace keeps its own memories and people. Switching workspaces does not move your history.",
          "Memory uses meeting transcripts, not email or computer activity.",
        ],
      },
      {
        title: "Sensitive topics",
        items: [
          "Include sensitive topics is off by default. Change it in Settings → Memory.",
          "When off, sensitive personal details such as health conditions are excluded. Explicit professional compensation expectations can still be remembered.",
          "Changes apply to meetings that start afterward. They do not update existing memories or person summaries.",
        ],
      },
      {
        title: "Forget a memory",
        items: [
          "Choose Forget to remove a memory from All and Where things stand.",
          "Summary lines based on that memory are removed from the person’s summary right away.",
          "Forgetting does not delete the original transcript or another participant’s memories. Ready keeps a minimal record to suppress the forgotten memory.",
          "Memories do not automatically expire. You still need access to their supporting meetings.",
        ],
      },
    ],
  },
  {
    slug: "settings-and-data",
    title: "Manage your account",
    navTitle: "Account",
    description: "Open Settings from your profile menu to manage preferences, connections, and data.",
    category: "Settings",
    sections: [
      {
        title: "Find the right setting",
        items: [
          "Account: Review your account, choose a light or dark appearance, or delete your account.",
          "Calendars: Connect accounts, reconnect them, or manage calendar data.",
          "Connected apps: Manage Linear and Slack.",
          "Memory: Choose whether future meetings can create memories about sensitive topics.",
          "Workspace, Members, and Billing: Manage your workspace where your role allows it.",
        ],
      },
      {
        title: "Remove data",
        items: [
          "Read the confirmation before deleting connected calendar data or your account.",
          "Resolve any subscription or workspace ownership requirements shown before deleting your account.",
          "For questions about your data, email info@ready.app. See Privacy for the full policy.",
        ],
      },
    ],
  },
  {
    slug: "connected-apps",
    title: "Connect Linear and Slack",
    navTitle: "Apps",
    description: "Use your existing tools to bring meeting context into your work.",
    category: "Settings",
    sections: [
      {
        title: "Connect an app",
        kind: "steps",
        items: [
          "Open Settings → Connected apps.",
          "Choose Linear or Slack and connect the account you want to use.",
          "Approve access, then return to Ready to review the connection settings.",
        ],
      },
      {
        title: "Linear",
        items: [
          "Ready can find relevant issues and projects, then draft updates for your review.",
          "Check the proposed changes before approving them.",
        ],
      },
      {
        title: "Slack",
        items: [
          "Choose a channel for each meeting category to share notes and tasks automatically.",
          "Categories without a channel are not posted. You can choose an existing channel or create one from the settings.",
          "Review the sensitive-content controls before saving your posting settings.",
        ],
      },
    ],
  },
  {
    slug: "workspaces",
    title: "Manage your workspace",
    navTitle: "Workspace",
    description: "Keep work organized and manage who belongs to your workspace.",
    category: "Settings",
    sections: [
      {
        title: "Switch or create",
        items: [
          "Open your profile menu to switch workspaces.",
          "Choose Create a new workspace to set up another workspace.",
          "Check the active workspace before reviewing meetings, tasks, memories, or billing.",
        ],
      },
      {
        title: "Manage the team",
        items: [
          "Owners and admins can manage workspace settings.",
          "Open Settings → Members to view the team. Invitation and member controls depend on your role.",
          "Available controls include changing roles, suspending access, and removing members.",
          "Only the owner can manage billing or transfer ownership.",
        ],
      },
    ],
  },
  {
    slug: "billing",
    title: "Manage your plan",
    navTitle: "Billing",
    description: "Review your workspace’s plan and AI usage in Settings → Billing.",
    category: "Settings",
    sections: [
      {
        title: "Plans and usage",
        items: [
          "Your first 3 meetings, on us. Available to eligible free accounts; AI limits apply.",
          "Paid plans add features such as meeting prep and Memory. Check the plan shown in Billing for current features and pricing.",
          "Review your remaining usage and available credit options before starting work that needs AI.",
        ],
      },
      {
        title: "Change a plan",
        items: [
          "Workspace owners can open Billing to choose or adjust a plan.",
          "Review the price, billing period, and renewal details before confirming a change.",
          "To cancel a paid subscription, choose Cancel under Cancel plan. Follow the billing portal’s steps to confirm.",
          "If Billing is missing, ask the workspace owner to manage the subscription.",
        ],
      },
    ],
  },
  {
    slug: "privacy-and-security",
    title: "Privacy and recording",
    navTitle: "Recording",
    description: "Understand what Ready processes and who can see meeting information.",
    category: "Settings",
    sections: [
      {
        title: "Recording and AI",
        items: [
          "Recording, transcription, and AI processing are core parts of Ready meetings.",
          "The Ready assistant can appear as a visible meeting participant.",
          "Tell participants about Ready and get any required consent before using it.",
          "Review AI-generated notes, tasks, and answers before relying on them.",
        ],
      },
      {
        title: "Access and policies",
        items: [
          "Confidential meetings are limited to participants. Confidentiality does not turn off recording or AI processing.",
          "Personal memories are private to you, even when a meeting is shared with the workspace.",
          "Open Privacy and Terms in the left navigation for the full policies and host responsibilities.",
        ],
      },
    ],
  },
  {
    slug: "troubleshoot-calendar",
    title: "Fix calendar problems",
    navTitle: "Calendar",
    description: "Check the account, connection, and event permissions first.",
    category: "Help",
    sections: [
      {
        title: "Missing events or links",
        items: [
          "Check that the connected Google or Microsoft account owns the calendar you expect to see.",
          "Open Settings → Calendars and reconnect the account if access has expired.",
          "To add or change a meeting link, the connected account must be able to edit the event.",
          "Refresh Upcoming after reconnecting.",
        ],
      },
      {
        title: "Google Calendar add-on",
        items: [
          "Confirm Ready is installed for the Google account currently open in Calendar.",
          "Complete any Authorize prompt, then reload Calendar.",
          "Try adding Ready to a new event you own. This helps check whether the original event’s permissions are the problem.",
        ],
      },
    ],
  },
  {
    slug: "troubleshoot-meetings",
    title: "Fix meeting problems",
    navTitle: "Meetings",
    description: "Resolve common issues with joining, devices, and screen sharing.",
    category: "Help",
    sections: [
      {
        title: "Microphone or camera",
        items: [
          "Allow camera and microphone access in your browser’s site settings for ready.app.",
          "Check the selected devices and confirm another app is not blocking them.",
          "Turn the device off and on in Ready. If needed, refresh and rejoin.",
        ],
      },
      {
        title: "Stuck joining",
        items: [
          "Check that you opened the correct meeting link.",
          "If you are waiting for approval, ask the host to admit your request.",
          "If your connection drops, reopen the meeting link to rejoin.",
        ],
      },
      {
        title: "Screen sharing",
        items: [
          "Try a different tab or window. Check your operating system’s screen-recording permission for the browser.",
          "Screen sharing and background blur depend on browser and device support.",
        ],
      },
    ],
  },
  {
    slug: "report-issue",
    title: "Contact support",
    navTitle: "Contact",
    description: "Email info@ready.app with a short description of the problem.",
    category: "Help",
    sections: [
      {
        title: "Include these details",
        items: [
          "What you expected, what happened, and the steps to reproduce it.",
          "Your Ready account email and the workspace involved.",
          "For meeting issues: the meeting title, time, and link.",
          "For connection issues: the provider and whether you used Ready or the Google Calendar add-on.",
          "Your browser and operating system. Add a screenshot if it helps, with sensitive information removed.",
        ],
      },
    ],
  },
];

export const docsCategories: DocsCategory[] = [
  {
    title: "Start",
    description: "Set up Ready and find your way around.",
    articles: ["getting-started"],
  },
  {
    title: "Calendar",
    description: "Connect your calendar and prepare for meetings.",
    articles: ["connect-calendar", "google-calendar-addon", "prepare-for-meetings"],
  },
  {
    title: "Meetings",
    description: "Join, host, and talk with Ready.",
    articles: ["join-meeting", "host-live-meeting", "use-agent-help"],
  },
  {
    title: "Follow-up",
    description: "Review notes, track tasks, and remember useful context.",
    articles: ["meeting-output", "tasks", "memory"],
  },
  {
    title: "Settings",
    description: "Manage your account, workspace, and connected apps.",
    articles: ["settings-and-data", "connected-apps", "workspaces", "billing", "privacy-and-security"],
  },
  {
    title: "Help",
    description: "Fix a problem or contact support.",
    articles: ["troubleshoot-calendar", "troubleshoot-meetings", "report-issue"],
  },
];

export function getDocsArticle(slug: string): DocsArticle | null {
  return docsArticles.find((article) => article.slug === slug) ?? null;
}

export function getDocsArticles(slugs: readonly string[]): DocsArticle[] {
  return slugs.map((slug) => getDocsArticle(slug)).filter((article): article is DocsArticle => Boolean(article));
}
