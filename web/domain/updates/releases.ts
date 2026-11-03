type ReleaseDetail = {
  area: string;
  text: string;
};

export type ReleaseVisual =
  | "summary"
  | "guests"
  | "people"
  | "typesafe"
  | "dark-notes"
  | "voice"
  | "marketplace"
  | "dark-memory"
  | "dark-tasks"
  | "meeting";

type ReleaseSection = {
  title: string;
  paragraphs: string[];
  visual?: ReleaseVisual;
};

export type Release = {
  slug: string;
  date: string;
  title: string;
  category: string;
  paragraphs: string[];
  improvements: ReleaseDetail[];
  fixes: ReleaseDetail[];
  visual?: ReleaseVisual;
  sections?: ReleaseSection[];
  visualCaption?: string;
};

const RELEASE_CONTENT: { releases: Release[] } = {
  releases: [
    {
      slug: "live-summary",
      date: "2026-10-12",
      category: "Meetings",
      title: "A live summary of your meeting",
      visual: "summary",
      paragraphs: [
        "Decisions and tasks, captured as they happen. Open Summary in the meeting room to see what you’ve agreed, what’s still an open question, and who’s doing what next. You can stay in the conversation while Ready keeps track.",
        "As the conversation moves on, the summary changes with it. Resolved questions leave the list, completed tasks disappear, and revised decisions replace earlier ones. Everyone with access sees the same summary, even if the host leaves.",
        "When the meeting ends, Ready uses the summary alongside the transcript to help prepare your notes and tasks. The work you clarified during the call carries through to the follow-up.",
      ],
      sections: [
        {
          title: "Voice chat with Ready",
          paragraphs: [
            "Talk with your Ready agent when you’re alone in the meeting. When another person joins, voice chat with Ready turns off and its button fades away. When you’re alone again, the button returns, ready for you to turn it back on.",
            "The meeting layout also makes room for arrivals more smoothly. Your tile shrinks into the corner as the other participant takes the main view.",
          ],
        },
        {
          title: "Pick up where you left off",
          paragraphs: [
            "Memory and People now keep recently viewed information ready as you move around your workspace. Open a person, return to your memories, or browse older conversations with less waiting.",
          ],
          visual: "dark-memory",
        },
        {
          title: "Review before you share",
          paragraphs: [
            "Slack sharing now gives you a review step before anything is sent. Check the summary and its recipients, then confirm. Messages are sent from your connected Slack account.",
            "Channel sharing is available for eligible sales calls. Other meetings use individual messages to matched participants. Existing Slack connections may need to be reconnected.",
          ],
        },
      ],
      improvements: [
        {
          area: "Summary",
          text: "Decisions, Open questions, and Tasks stay visible, including when a section has nothing to show yet.",
        },
        {
          area: "Summary",
          text: "Tasks focus on concrete commitments rather than passing suggestions.",
        },
        {
          area: "Summary",
          text: "Ask Ready to clear the summary or bring back previously captured items during the call.",
        },
        {
          area: "Meetings",
          text: "The live transcript closes when you click outside it and sits closer to the meeting controls.",
        },
        {
          area: "Performance",
          text: "Meeting animations do less background work, and camera capture defaults to 720p to reduce processing load.",
        },
        {
          area: "Memory",
          text: "Search and filters can find people beyond the first page of results.",
        },
        {
          area: "Calendar",
          text: "A shortcut in the workspace sidebar makes the Google Calendar add-on easier to find.",
        },
        {
          area: "Mobile",
          text: "About and Updates are easier to reach from the public navigation menu.",
        },
      ],
      fixes: [
        {
          area: "Summary",
          text: "Reopening or reconnecting to a meeting restores the saved summary.",
        },
        {
          area: "Voice chat with Ready",
          text: "A delayed start response can no longer turn voice chat with Ready back on after another participant joins.",
        },
        {
          area: "Meetings",
          text: "Opening Summary closes other meeting panels so they do not overlap.",
        },
        {
          area: "Memory",
          text: "Forgotten memories are removed from cached views across open tabs.",
        },
        {
          area: "Slack",
          text: "A guest in the meeting no longer prevents sharing preparation for eligible signed-in participants.",
        },
        {
          area: "Slack",
          text: "Sharing errors now appear as notifications instead of replacing the menu.",
        },
        {
          area: "Notes",
          text: "The Tasks heading stays in place while tasks are being prepared.",
        },
      ],
    },
    {
      slug: "context-for-the-people-you-meet",
      date: "2026-09-30",
      category: "People",
      title: "More useful person cards",
      visual: "people",
      paragraphs: [
        "Person cards now bring details from past conversations together with information from the web. Open a card during a meeting to catch up on someone and see what you last discussed.",
        "If you use Ashby for hiring, cards can also include the candidate’s role, hiring stage, and hiring team. An admin connects Ashby, and each person chooses whether to use it. Memories and connected-app details stay private to you.",
        "Cards can appear for meeting participants, including the host, and use the same profiles available in People after the call.",
      ],
      improvements: [
        {
          area: "Ashby",
          text: "People who have connected Ashby can open a candidate’s hiring profile from People.",
        },
        {
          area: "People",
          text: "Person cards show available memory and Ashby details while web research continues.",
        },
        {
          area: "People",
          text: "Memory and Ashby details load independently, so one unavailable source does not hide the other.",
        },
        {
          area: "People",
          text: "Profile photos carry through to People and meeting cards, with initials when a photo cannot load.",
        },
        {
          area: "People",
          text: "Person cards show an email address when the role and company are unavailable.",
        },
        {
          area: "Guests",
          text: "Signed-in participants no longer see the “Remember me next time” checkbox.",
        },
        {
          area: "Guests",
          text: "Returning guests can edit their remembered name before asking to join.",
        },
        {
          area: "Guests",
          text: "Uncheck “Remember me next time” before joining to stop being remembered on this browser.",
        },
        {
          area: "Meetings",
          text: "Improved spacing and admission controls in the waiting list.",
        },
        {
          area: "Meetings",
          text: "The waiting room, invitation card, and person cards now share a more consistent appearance.",
        },
        {
          area: "Calendar",
          text: "Calendar cards now show event dates and align titles, links, and details consistently.",
        },
        {
          area: "Calendar",
          text: "Calendar errors now distinguish missing access, unavailable events, and service problems.",
        },
        {
          area: "Meetings",
          text: "Guests and other participants can leave directly using the red call button.",
        },
        {
          area: "Video",
          text: "Camera and screen sharing choose their quality settings independently.",
        },
        {
          area: "Video",
          text: "Video quality settings now carry through camera changes and reconnects.",
        },
        {
          area: "Video",
          text: "Video quality adjusts when your computer is struggling, then improves gradually when it can handle more.",
        },
        {
          area: "Video",
          text: "Three-person calls center the third tile beneath the first two on wider screens.",
        },
        {
          area: "Research",
          text: "Jev, an AI model from TypeSafe, helps spot mentions of people and companies worth checking.",
        },
        {
          area: "Research",
          text: "Names that are hard to make out get a closer look instead of being dismissed immediately.",
        },
        {
          area: "Research",
          text: "Company mentions are checked for useful public background.",
        },
        {
          area: "Research",
          text: "Ready uses nearby sentences to piece together names spoken in several parts.",
        },
        {
          area: "Research",
          text: "A small name button appears when a search starts and updates when the details arrive.",
        },
        {
          area: "Agent",
          text: "The assistant can look further back in the meeting for context when answering a question.",
        },
        {
          area: "Agent",
          text: "The assistant can give a brief progress update while a longer meeting answer is being prepared.",
        },
        {
          area: "Agent",
          text: "Spoken search requests pay closer attention to the date and place you asked about.",
        },
        {
          area: "Agent",
          text: "Meeting answers remain available in Recent during the session.",
        },
        {
          area: "Calendar",
          text: "Upcoming meetings now include calendar events with no other invitees.",
        },
        {
          area: "Meetings",
          text: "Your name stays filled in if the meeting ends while you are waiting to join.",
        },
        {
          area: "Notes",
          text: "Verified sources can help correct company names in research without changing the transcript or quotes.",
        },
        {
          area: "Calendar",
          text: "Choose Ready Meeting directly from Google Calendar’s video-conferencing menu.",
        },
        {
          area: "Calendar",
          text: "Choosing Ready again for the same calendar event keeps the same meeting link.",
        },
        {
          area: "Calendar",
          text: "Joining details include a phone number and PIN when phone access is available.",
        },
        {
          area: "Calendar",
          text: "Saved events include joining details in their description without replacing the agenda.",
        },
        {
          area: "Sign-in",
          text: "Use your Google account to create or connect your Ready account, without a separate signup form.",
        },
      ],
      fixes: [
        {
          area: "Meetings",
          text: "Fixed navigation and private memory using the wrong workspace after joining a teammate’s meeting.",
        },
        {
          area: "People",
          text: "An unsuccessful web search no longer hides useful memories or hiring details from Ashby.",
        },
        {
          area: "People",
          text: "Useful private details stay visible even when web research cannot find a result.",
        },
        {
          area: "Research",
          text: "Ready can match a nickname to a person when the pages it finds explain the connection.",
        },
        {
          area: "Tasks",
          text: "Fixed tasks failing to appear after meetings with lots of follow-up work.",
        },
        {
          area: "Guests",
          text: "Fixed a remembered name replacing a name you had already started typing.",
        },
        {
          area: "Meetings",
          text: "Fixed cut-off letters in the button for letting guests in.",
        },
        {
          area: "Meetings",
          text: "Removed the “Try with a different name” button after a host declines entry.",
        },
        {
          area: "People",
          text: "Fixed remembered guests’ profile names being replaced after each visit.",
        },
        {
          area: "Research",
          text: "The details panel closes when there is nothing to show and no search is running.",
        },
        {
          area: "Calendar",
          text: "All-day events keep their calendar date instead of shifting with the time zone.",
        },
        {
          area: "Calendar",
          text: "Prevented duplicate Ready details after a calendar editor reformats an event description.",
        },
        {
          area: "Calendar",
          text: "Calendar cards keep a readable Ready icon when an event date is unavailable.",
        },
        {
          area: "Calendar",
          text: "Updating one meeting link preserves links to other meetings and the notes around them.",
        },
        {
          area: "Calendar",
          text: "Fixed Ready links failing to be added to some calendar events.",
        },
        {
          area: "Meetings",
          text: "Fixed getting stuck when leaving a call while the camera or microphone was shutting down.",
        },
        {
          area: "Meetings",
          text: "Fixed cameras and microphones starting after you had already left the call.",
        },
        {
          area: "Meetings",
          text: "Fixed canceled join attempts adding you to the meeting later.",
        },
        {
          area: "Video",
          text: "A failed video-quality adjustment no longer interrupts an otherwise working camera.",
        },
        {
          area: "Video",
          text: "Fixed the other person’s video being cropped in one-to-one calls.",
        },
        {
          area: "Video",
          text: "Fixed mirrored video making text held up by the other person hard to read.",
        },
        {
          area: "Video",
          text: "Fixed background effects undoing camera settings adjusted for performance.",
        },
        {
          area: "Research",
          text: "Mentioning the same person or company again can reuse its card instead of creating another.",
        },
        {
          area: "Research",
          text: "People with the same name and different stated employers remain separate.",
        },
        {
          area: "Research",
          text: "Long stretches of conversation can be checked for names without skipping the end.",
        },
        {
          area: "Research",
          text: "Fixed follow-up research hiding a previously completed answer.",
        },
        {
          area: "Research",
          text: "Fixed unsuccessful searches switching you away from the button to try again.",
        },
        {
          area: "Research",
          text: "Fixed existing results appearing as new after rejoining or reloading a meeting.",
        },
        {
          area: "Research",
          text: "Fixed photo and background updates changing the selected item in Recent.",
        },
        {
          area: "Research",
          text: "Clicking “Try again” more than once no longer starts the same search repeatedly.",
        },
        {
          area: "Agent",
          text: "A message explains when a problem has stopped your voice conversation.",
        },
        {
          area: "Agent",
          text: "Fixed spoken answers being cut short, including explanations of when an answer might not apply.",
        },
        {
          area: "Agent",
          text: "Fixed simultaneous setup requests preventing the assistant from becoming ready.",
        },
        {
          area: "Calendar",
          text: "Ready finds meeting links in an Outlook invitation’s location and description, as well as its video-call details.",
        },
        {
          area: "Meetings",
          text: "Fixed ongoing meetings being interrupted by a temporary sign-in problem.",
        },
        {
          area: "Meetings",
          text: "Fixed a host’s waiting request remaining in the list after they signed in and joined.",
        },
        {
          area: "Meetings",
          text: "Fixed unused scheduled meetings ending when a waiting guest left.",
        },
        {
          area: "Notes",
          text: "Removed a brief “Meeting notes are locked” error before the upgrade preview.",
        },
        {
          area: "Notes",
          text: "Fixed being asked to upgrade before viewing notes included in your trial.",
        },
        {
          area: "Notes",
          text: "Stopped upgrade messages appearing for meetings that were too short to produce notes.",
        },
        {
          area: "Notes",
          text: "Notes can begin while Ready finishes disconnecting phone callers.",
        },
        {
          area: "Notes",
          text: "Repeated summary requests reuse the existing work instead of overwriting saved notes.",
        },
        {
          area: "Research",
          text: "Discarded search results no longer flash in the panel or remain in its history.",
        },
        {
          area: "Research",
          text: "Delayed research progress no longer replaces results that have already been presented.",
        },
        {
          area: "Research",
          text: "Fixed search results dropping short facts such as prices, scores, and dates.",
        },
        {
          area: "Research",
          text: "Preserved source links when preparing a research answer fails.",
        },
        {
          area: "Research",
          text: "Reduced duplicate searches from the same spoken request.",
        },
        {
          area: "Slack",
          text: "Fixed Slack follow-ups failing while Ready identified the meeting type.",
        },
        {
          area: "Tasks",
          text: "Fixed the task assignment menu failing to show people when a workspace included an Owner.",
        },
      ],
      sections: [
        {
          title: "Remember returning guests",
          paragraphs: [
            "Guests can now return to Ready with their name already filled in. Select “Remember me next time” before joining to be recognized on the same browser, without creating an account.",
            "Remembered visits also stay together in other participants’ People profiles, making past conversations easier to find. You can edit your name or turn remembering off before joining. The host still approves each visit.",
            "Already have an account? Stay signed in with Google or Microsoft as usual. This option is only for guests.",
          ],
        },
        {
          title: "Adaptive video quality",
          paragraphs: [
            "Ready now adjusts camera and screen-sharing quality to suit your browser and computer. More capable devices get higher-quality video, while others use settings they can run comfortably. Each adjusts separately, so a clearer camera does not have to come at the expense of your presentation.",
            "Calendar cards are easier to scan, too. Updating a Ready meeting link now preserves other meeting links and the notes around them.",
          ],
        },
        {
          title: "Ask about your meeting",
          paragraphs: [
            "You can now ask your assistant what was decided earlier or what someone just said. Ready looks back through the written conversation, answers aloud, and shows more detail beside the call.",
            "For questions that need information from the web, Ready uses Parallel Web Systems’ Turbo search service to find pages it can read. It can search further when the first results do not answer the question and keep track of what it has found.",
            "This lets Ready explore a question across several sources while you stay in the meeting. Links stay with the answer so you can check a detail or read more.",
          ],
        },
        {
          title: "Ready for Google Calendar",
          paragraphs: [
            "The Ready add-on has been approved for the Google Workspace Marketplace. Add Ready meetings directly to calendar events, without switching between apps.",
            "To get started, create or edit an event and choose “Ready Meeting” from the video-call menu. Ready adds a join link, plus a phone number and PIN when phone access is available. Choosing Ready again for the same event keeps the existing link.",
            "Saving the event also adds the joining details to its description while keeping your agenda intact. Your Google account creates or connects your Ready account, with no separate password or signup form.",
            "You can also open Ready from the Calendar sidebar. Connecting your calendar inside Ready remains a separate choice.",
          ],
        },
      ],
    },
    {
      slug: "introducing-people-and-memory",
      date: "2026-09-20",
      category: "Memory",
      title: "Memory, People, and mobile notes",
      visual: "dark-memory",
      paragraphs: [
        "Introducing Memory and People, a place to revisit useful details from your conversations and prepare for the next one. Browse by person or date, read a short summary, and see where things stand.",
        "Open a memory to see the words it came from, or use search and filters to find a specific detail. Memories are private to you within each workspace. You can forget individual details without removing unrelated memories.",
      ],
      improvements: [
        {
          area: "Memory",
          text: "Browse memories by date or by person.",
        },
        {
          area: "Memory",
          text: "Open a memory to see the words it came from.",
        },
        {
          area: "Memory",
          text: "Search memories and narrow the list by category.",
        },
        {
          area: "Memory",
          text: "Forget an individual memory without removing unrelated details from the same conversation.",
        },
        {
          area: "Memory",
          text: "A single “Preparing memories” row shows when new memories are on the way.",
        },
        {
          area: "Memory",
          text: "Read more of the conversation behind a memory while keeping its controls within reach.",
        },
        {
          area: "People",
          text: "People profiles bring summaries, recent details, and past meetings together.",
        },
        {
          area: "Memory",
          text: "Memory cards and filters fit smaller screens more comfortably.",
        },
        {
          area: "Mobile",
          text: "Meeting preparation and Linear menus have roomier buttons that are easier to tap.",
        },
        {
          area: "Mobile",
          text: "Meeting and person pages share a consistent back button on mobile.",
        },
        {
          area: "Tasks",
          text: "The person responsible appears below each task on narrow screens.",
        },
        {
          area: "Tasks",
          text: "Task editing leaves more room for multiline notes.",
        },
        {
          area: "Tasks",
          text: "Completed tasks can be cleared by age, selection, or the entire Done list.",
        },
        {
          area: "Workspace",
          text: "Notes and memories you have already opened can appear sooner when you return.",
        },
        {
          area: "Meetings",
          text: "Leaving an ongoing call shows early conclusions and a way to rejoin after a short wait.",
        },
        {
          area: "Notes",
          text: "Guest notes open directly when you return to a finished meeting.",
        },
        {
          area: "Notes",
          text: "Signed-in invitees now move from the call to notes in the same way as the organizer.",
        },
        {
          area: "Notes",
          text: "Guests can read finalized notes and tasks before creating an account.",
        },
        {
          area: "Video",
          text: "The waiting room keeps your camera preview visible while background blur starts.",
        },
        {
          area: "Billing",
          text: "Plan selection supports dark mode.",
        },
        {
          area: "Billing",
          text: "See your trial meetings separately from credits you bought or received.",
        },
        {
          area: "Billing",
          text: "The remaining trial meetings appear in the current-plan card.",
        },
        {
          area: "Billing",
          text: "“Upgrade now” opens monthly checkout directly, while “View all plans” opens the plan chooser.",
        },
        {
          area: "Tasks",
          text: "Notes, voice replies, and usage labels now use “tasks” consistently.",
        },
        {
          area: "Workspace",
          text: "Settings pages share a centered, consistent content width.",
        },
      ],
      fixes: [
        {
          area: "Meetings",
          text: "Meetings hosted by another workspace stay in the workspace you joined from, rather than appearing everywhere.",
        },
        {
          area: "Memory",
          text: "Fixed a connection problem preventing Ready from preparing memories.",
        },
        {
          area: "Memory",
          text: "Fixed memories failing to save after meetings hosted by another workspace.",
        },
        {
          area: "Memory",
          text: "Error messages you dismiss no longer keep coming back as the page updates.",
        },
        {
          area: "Meetings",
          text: "Fixed leaving one tab marking you absent while you were connected on another device.",
        },
        {
          area: "Meetings",
          text: "Fixed guests still appearing present after they left.",
        },
        {
          area: "Meetings",
          text: "Fixed delayed disconnect notices making participants disappear after rejoining.",
        },
        {
          area: "Memory",
          text: "Time links in memories take you to the words they came from.",
        },
        {
          area: "Memory",
          text: "The date guide beside your memories lines up with the oldest entry, even in short lists.",
        },
        {
          area: "Notes",
          text: "Returning from meeting notes preserves your place in the list.",
        },
        {
          area: "Tasks",
          text: "Short task lists stay at the top of the mobile view.",
        },
        {
          area: "Tasks",
          text: "Fixed tasks from meetings hosted in another workspace missing from Mine.",
        },
        {
          area: "Tasks",
          text: "Fixed task updates missing for attendees of meetings hosted in another workspace.",
        },
        {
          area: "Tasks",
          text: "Fixed selected tasks appearing updated before all changes had saved.",
        },
        {
          area: "Tasks",
          text: "Unfinished tasks stay visible if a change to several tasks fails, with guidance for trying again.",
        },
        {
          area: "Workspace",
          text: "Reduced brief flashes of loading messages and empty lists as you move around Ready.",
        },
        {
          area: "Notes",
          text: "Reduced flashes of incomplete content between the call and your notes.",
        },
        {
          area: "Notes",
          text: "Fixed rejoining from notes losing your guest identity.",
        },
        {
          area: "Notes",
          text: "Refreshing finished guest notes no longer replays the leaving-meeting animation.",
        },
        {
          area: "Notes",
          text: "Temporary connection failures while waiting for notes show a brief notice instead of a persistent red error.",
        },
        {
          area: "Video",
          text: "Toggling background blur no longer restarts the camera and microphone.",
        },
        {
          area: "Video",
          text: "Preview controls stay centered as the camera and blur settings change.",
        },
        {
          area: "Billing",
          text: "Trial offers disappear when the signed-in member is no longer eligible.",
        },
        {
          area: "Notes",
          text: "Previously saved notes with an “Action items” heading continue to display correctly.",
        },
        {
          area: "Sign-in",
          text: "Fixed direct sign-in failing for people who had not used the Calendar add-on.",
        },
      ],
      sections: [
        {
          title: "Meeting notes on mobile",
          paragraphs: [
            "Meeting notes now open in a dedicated view on your phone, with larger text and more room for menus. Go back to return to the same place in your meeting list.",
            "You can also swipe through memory cards. Previously opened notes and People pages can load sooner when you return, making it easier to move between conversations.",
          ],
        },
        {
          title: "Meeting notes for guests",
          paragraphs: [
            "Guests and signed-in invitees now get the same transition from a finished call to its summary and tasks. Guests who joined can read the notes without creating an account.",
            "Leave before the meeting ends and you can see early takeaways while the final notes are being prepared. A rejoin link takes you back to the ongoing call.",
          ],
        },
        {
          title: "Simpler billing",
          paragraphs: [
            "Your plan, remaining trial meetings, and upgrade options now appear together in billing settings. Compare plans or open checkout directly from your current plan.",
            "Meeting follow-ups are now called tasks throughout Ready, including notes, usage labels, and assistant replies.",
          ],
        },
      ],
    },
    {
      slug: "a-faster-way-through-your-tasks",
      date: "2026-09-09",
      category: "Tasks",
      title: "A faster way through your tasks",
      paragraphs: [
        "A longer list does not have to mean more clicking. Drag across several tasks to select them, then complete or remove them together. Clear highlighting shows what you have selected.",
        "Your assigned tasks are grouped by recent activity: this week, last week, and earlier months. Close a group to keep your attention on what matters now.",
      ],
      improvements: [
        {
          area: "Tasks",
          text: "Complete or remove all the tasks you selected together.",
        },
        {
          area: "Tasks",
          text: "Task highlighting matches your chosen light or dark appearance.",
        },
        {
          area: "Tasks",
          text: "Drag across task rows to select several at once.",
        },
        {
          area: "Tasks",
          text: "Collapse activity groups to focus on this week, last week, or an earlier month.",
        },
        {
          area: "Tasks",
          text: "Selected tasks are highlighted so you can see which ones you are about to change.",
        },
        {
          area: "Video",
          text: "Your own camera stays visible without taking half the screen.",
        },
        {
          area: "Video",
          text: "Video windows keep moving smoothly into place even when people join or leave quickly.",
        },
        {
          area: "People",
          text: "Available profile images appear alongside the person or company name.",
        },
        {
          area: "People",
          text: "Initials appear when a profile photo is unavailable.",
        },
        {
          area: "Research",
          text: "Cards include source links so you can explore the original material.",
        },
        {
          area: "Research",
          text: "Open a name button to read more about a person or company without leaving the call.",
        },
        {
          area: "Research",
          text: "Repeated mentions of the same person or company stay together in one card.",
        },
      ],
      fixes: [],
      sections: [
        {
          title: "Select and organize tasks",
          paragraphs: [
            "You can now drag across tasks to select several at once, then complete or remove them together. Selected rows are highlighted so you can see exactly what will change.",
            "Assigned tasks are grouped by this week, last week, and earlier months. Collapse a group to focus on the work you need.",
          ],
        },
        {
          title: "People and company cards",
          paragraphs: [
            "People and companies mentioned in a meeting can now appear in cards with a short introduction, useful facts, and links to read more. Click a name near the meeting controls to open its card.",
            "Ready uses Parallel Web Systems’ Turbo search service to find public pages, then checks the name and details from the conversation for a match. This gives Ready information it can verify on the web instead of relying only on what an AI already knows.",
            "The original pages stay linked, so you can explore the background without searching from scratch.",
          ],
        },
        {
          title: "A new layout for one-to-one calls",
          paragraphs: [
            "One-to-one calls now give the other person the main view. Your own camera stays in a small corner window, leaving more space for the conversation.",
            "When another person joins, the layout switches to a grid. Video windows move into place as people arrive or leave.",
          ],
        },
      ],
      visual: "dark-tasks",
    },
    {
      slug: "meetings-that-fit-your-phone",
      date: "2026-08-26",
      category: "Meetings",
      title: "Dark mode and mobile meetings",
      paragraphs: [
        "Meeting controls now leave more space around your phone’s edges and bottom bar. Camera views show the full picture, including when you hold your phone upright.",
        "You can also log out from the workspace menu on mobile.",
      ],
      improvements: [
        {
          area: "Meetings",
          text: "Controls adapt to narrow screens without covering the meeting view.",
        },
        {
          area: "Meetings",
          text: "Meeting buttons leave space for your phone’s edges and bottom bar.",
        },
        {
          area: "Sign-in",
          text: "Log out directly from the mobile workspace menu.",
        },
        {
          area: "Video",
          text: "Camera previews and mobile video tiles show the full frame.",
        },
        {
          area: "Billing",
          text: "Choosing Pro continues to checkout after sign-in.",
        },
        {
          area: "Billing",
          text: "Pricing FAQs cover billing, cancellation, and data security.",
        },
        {
          area: "Billing",
          text: "Plan descriptions are consistent between pricing and billing settings.",
        },
        {
          area: "Linear",
          text: "The Linear correction field keeps its submit button in one place.",
        },
        {
          area: "Workspace",
          text: "Settings menus behave consistently when you use the keyboard or close them.",
        },
        {
          area: "Workspace",
          text: "Appearance changes carry across your open tabs.",
        },
        {
          area: "Workspace",
          text: "Your saved appearance is applied before the page first appears.",
        },
        {
          area: "Workspace",
          text: "Loading text uses less animation when you have asked your device to reduce motion.",
        },
      ],
      fixes: [
        {
          area: "Captions",
          text: "Fixed long delays in finishing captions when you were not using voice chat with Ready.",
        },
        {
          area: "Research",
          text: "Interrupted searches now show an explanation instead of an endless loading indicator.",
        },
        {
          area: "Research",
          text: "Fixed completed web research sometimes leaving its loading panel spinning.",
        },
        {
          area: "Research",
          text: "Long research results are shortened to fit instead of leaving the details panel stuck.",
        },
        {
          area: "Video",
          text: "Fixed the camera failing to start after joining with background blur enabled.",
        },
        {
          area: "Video",
          text: "Fixed camera and microphone menus showing old settings after changes to the preview.",
        },
        {
          area: "Workspace",
          text: "Fixed a stuck pressed appearance on the mobile menu button.",
        },
        {
          area: "Billing",
          text: "Repeated checkout clicks reuse the same checkout attempt.",
        },
        {
          area: "Billing",
          text: "Your plan and balance update more reliably if a payment confirmation is interrupted.",
        },
        {
          area: "Linear",
          text: "Password managers no longer try to fill the Linear correction field.",
        },
        {
          area: "Linear",
          text: "Click anywhere inside the Linear correction box to start typing.",
        },
        {
          area: "Workspace",
          text: "Loading indicators now follow your selected appearance.",
        },
        {
          area: "Workspace",
          text: "Fixed a visible seam in shimmering loading text.",
        },
      ],
      sections: [
        {
          title: "Dark mode",
          paragraphs: [
            "You can now choose Light or Dark in settings. Your appearance applies across the workspace, including notes, tasks, and loading indicators.",
            "The choice is saved in your browser and shared across open tabs.",
          ],
        },
        {
          title: "Simpler upgrades",
          paragraphs: [
            "Choosing Pro on the pricing page now takes you directly toward checkout. If you need to sign in, Ready remembers your choice so you can continue afterward.",
            "The pricing page and homepage also include answers to common questions about plans, billing, and cancellation.",
          ],
        },
      ],
      visual: "dark-notes",
    },
    {
      slug: "a-conversation-with-your-assistant",
      date: "2026-08-13",
      category: "Assistant",
      title: "Voice conversations and meeting notes",
      paragraphs: [
        "You can now talk back and forth with your assistant during a meeting. Click the voice button to start, click it again to finish, or press Escape to interrupt the assistant’s speech.",
        "The voice conversation stays with the person who started it, even when another participant joins.",
      ],
      improvements: [
        {
          area: "Agent",
          text: "The voice control shows when a conversation is starting or already in use.",
        },
        {
          area: "Agent",
          text: "Click the voice icon again to end the conversation.",
        },
        {
          area: "Agent",
          text: "Press Escape to interrupt the assistant’s speech.",
        },
        {
          area: "Agent",
          text: "An active voice conversation continues when another participant joins.",
        },
        {
          area: "Notes",
          text: "Meeting titles appear while the fuller notes are still being prepared.",
        },
        {
          area: "Notes",
          text: "Early takeaways can appear while the full meeting notes are being prepared.",
        },
        {
          area: "Tasks",
          text: "A clear request to fix a problem can become a task even before someone is assigned to it.",
        },
        {
          area: "Tasks",
          text: "Members can remove meeting tasks from their own assigned list.",
        },
        {
          area: "Tasks",
          text: "Notes and tasks use the main language of the full conversation.",
        },
        {
          area: "Tasks",
          text: "Ready can use the surrounding conversation to work out who should do a task.",
        },
        {
          area: "Meetings",
          text: "New meetings start with participant-only access.",
        },
        {
          area: "Meetings",
          text: "Existing meetings keep their previous confidentiality setting.",
        },
        {
          area: "Linear",
          text: "Linear drafts use the conversation to describe the problem and how it happened.",
        },
        {
          area: "Linear",
          text: "Check draft issue details and the conversation behind them before sending.",
        },
        {
          area: "Linear",
          text: "Corrections can name an existing issue as the destination.",
        },
        {
          area: "Linear",
          text: "Choose the recommended mix of new and existing issues, or create all new issues.",
        },
        {
          area: "Linear",
          text: "If sending to Linear fails, Ready shows which issue was affected and what did not finish.",
        },
        {
          area: "Calendar",
          text: "A reconnect prompt appears when an older calendar connection needs contact access.",
        },
        {
          area: "Meetings",
          text: "Search connected contacts without leaving the room.",
        },
        {
          area: "Meetings",
          text: "Invite several people at once from Google or Outlook contacts.",
        },
        {
          area: "Meetings",
          text: "Invitation emails include dial-in details when the meeting has them.",
        },
        {
          area: "Meetings",
          text: "Failed invitations identify the affected recipient while other invitations continue.",
        },
      ],
      fixes: [
        {
          area: "Agent",
          text: "Voice chat with Ready ends cleanly when the participant who started it leaves.",
        },
        {
          area: "Agent",
          text: "A failed start restores the voice button to its previous state.",
        },
        {
          area: "Agent",
          text: "Fixed the assistant missing a reply when the written version of speech arrived late.",
        },
        {
          area: "Meetings",
          text: "Empty one-to-one calls no longer fail while preparing a meeting title.",
        },
        {
          area: "Notes",
          text: "Fixed repeated Overview headings in notes written in other languages.",
        },
        {
          area: "Notes",
          text: "Fixed longer meetings timing out before their notes could finish generating.",
        },
        {
          area: "Notes",
          text: "Prevented duplicate notes when the first attempt took longer than expected.",
        },
        {
          area: "Tasks",
          text: "Task assignment menus stay visible in narrow lists and near the bottom of the screen.",
        },
        {
          area: "Tasks",
          text: "Fixed deleting several tasks at once silently skipping tasks from meetings.",
        },
        {
          area: "Tasks",
          text: "Reduced cases where the person requesting help was mistaken for the person doing the task.",
        },
        {
          area: "Workspace",
          text: "The loading transition continues smoothly from the call into the workspace.",
        },
        {
          area: "Captions",
          text: "Caption updates stay in order when the connection is slow.",
        },
        {
          area: "Captions",
          text: "Improved delivery of final captions as a meeting ends.",
        },
        {
          area: "Video",
          text: "A remembered camera that is no longer available falls back to the browser’s default camera.",
        },
        {
          area: "Linear",
          text: "Closed issues are excluded from duplicate suggestions.",
        },
        {
          area: "Linear",
          text: "Fixed screen-capture uploads failing before the image reached Linear.",
        },
        {
          area: "Linear",
          text: "Failed screenshot uploads can be retried without creating another Linear issue.",
        },
        {
          area: "Linear",
          text: "A failed image upload no longer prevents the issue itself from being created.",
        },
        {
          area: "Linear",
          text: "Prevented duplicate images when retrying an upload.",
        },
        {
          area: "Linear",
          text: "Fixed automatically captured screenshots failing to attach to Linear issues.",
        },
        {
          area: "Linear",
          text: "Fixed failed sends to Linear leaving the review stuck.",
        },
        {
          area: "Linear",
          text: "Fixed retries including unrelated tasks changed after the review.",
        },
        {
          area: "Linear",
          text: "Fixed copied meeting details causing an issue to be suggested as its own duplicate.",
        },
        {
          area: "Linear",
          text: "Generic words such as “fix” no longer make unrelated issues look like duplicates.",
        },
        {
          area: "Linear",
          text: "Corrections such as “create all new issues” now change the destination as well as the draft.",
        },
        {
          area: "Notes",
          text: "Fixed the loading screen staying open instead of showing the upgrade preview after a meeting.",
        },
      ],
      sections: [
        {
          title: "Meeting notes that get the details right",
          paragraphs: [
            "Great meeting notes capture more than the conversation. They make it clear what was decided, who committed to what, and what needs to happen next. Ready now uses more of the conversation to bring those details together in your summary and tasks.",
            "Knowing who said what makes the difference. Ready connects words to the participant who said them, then uses the surrounding conversation to understand who is taking on the work. If you ask someone to send a proposal, that task is less likely to end up on your list just because you mentioned it.",
            "The same attention to context helps Ready choose the right language for your notes. A quick greeting in another language is less likely to change the whole summary. That means less time correcting the language of your notes afterward.",
            "You can return to your workspace while the notes are being prepared. Early takeaways can appear first, followed by the full summary and tasks, so you can keep moving while Ready handles the follow-up.",
          ],
        },
        {
          title: "Private meetings by default",
          paragraphs: [
            "New meetings now start with access limited to the people who took part. Existing meetings keep the sharing settings you already chose.",
            "Ready also handles missing cameras more gracefully. If your previous camera is unavailable, it tries your browser’s default camera so you can continue joining.",
          ],
        },
        {
          title: "Send meeting tasks to Linear",
          paragraphs: [
            "You can now turn meeting tasks into draft Linear issues. Connect Linear to get started. Ready groups related tasks and suggests a team, then the meeting owner reviews the drafts before anything is sent.",
            "Ask for changes in everyday language, choose an existing issue to update, or create a new one. You can also review screenshots before including them. Once sent, the original tasks leave Ready so you can track the work in Linear.",
          ],
        },
        {
          title: "Invite people during a meeting",
          paragraphs: [
            "Signed-in participants can now invite people without leaving the call. Copy the meeting link or search your connected Google or Outlook contacts to send an invitation.",
            "Invitations include the join link and phone details when available. Older calendar connections may need to be reconnected to allow contact search.",
          ],
        },
      ],
      visual: "voice",
    },
    {
      slug: "clearer-screens-better-notes",
      date: "2026-07-24",
      category: "Meetings",
      title: "Workspaces, meeting notes, and shared tasks",
      paragraphs: [
        "Screen sharing now prioritizes readable text when the connection slows down. This helps people read the document you’re discussing, including in smaller windows.",
        "Ready also captures spoken to-do lists more reliably across several sentences. Repeated tasks are combined while keeping the person responsible, and unrelated work is less likely to be assigned to you after the topic changes.",
        "Short meetings can retain every distinct task supported by the conversation, even when more tasks are discussed than expected. Company names in email addresses help with spelling, and brief greetings in another language are less likely to affect meeting titles.",
        "Repeatable checks with example conversations now cover missed tasks, duplicate tasks, and incorrect assignments. These checks help catch the same problems when task generation changes.",
      ],
      improvements: [
        {
          area: "Notes",
          text: "Company names in participants’ email addresses help Ready spell company and product names in notes.",
        },
        {
          area: "Tasks",
          text: "Task completion and reassignment updates reach other open views more promptly.",
        },
        {
          area: "Tasks",
          text: "Ready keeps track of your spoken to-do list across several sentences, so tasks are less likely to be missed.",
        },
        {
          area: "Video",
          text: "Screen sharing keeps text readable when the connection slows down.",
        },
        {
          area: "Calendar",
          text: "Choose which connected calendars are used in each workspace.",
        },
        {
          area: "Calendar",
          text: "Calendar settings show “Used here” or “Use here” for each account.",
        },
        {
          area: "Calendar",
          text: "If no calendar is enabled in the current workspace, a prompt takes you to the chooser.",
        },
        {
          area: "Meeting prep",
          text: "Meeting-preparation results and calendar tools follow the meeting’s workspace.",
        },
        {
          area: "Tasks",
          text: "People assigned to tasks show initials when they have no profile photo.",
        },
        {
          area: "Workspace",
          text: "Accepting an invitation takes you straight into that workspace.",
        },
        {
          area: "Workspace",
          text: "Connected apps now have a Manage view for their settings.",
        },
        {
          area: "Workspace",
          text: "Owners can transfer workspace ownership with confirmation.",
        },
        {
          area: "Workspace",
          text: "Members can be given new roles, suspended, or reactivated according to your permissions.",
        },
        {
          area: "Workspace",
          text: "Switching workspaces fades smoothly, with less animation when your device asks for reduced motion.",
        },
        {
          area: "Tasks",
          text: "Reassign tasks without losing track of them as they move between views.",
        },
        {
          area: "Tasks",
          text: "Create shared, unassigned tasks directly in Others.",
        },
        {
          area: "Tasks",
          text: "Complete visible shared meeting tasks and reopen them from Done.",
        },
        {
          area: "Tasks",
          text: "Small profile photos show who is responsible beside the link to each task’s meeting.",
        },
        {
          area: "Notes",
          text: "Press Option + Shift + S to copy the summary and tasks from the meeting view.",
        },
        {
          area: "Notes",
          text: "Copied follow-ups keep bullets and bold task titles in email apps that support them.",
        },
        {
          area: "Notes",
          text: "Copied tasks include their descriptions without extra owner, due-date, or status labels.",
        },
      ],
      fixes: [
        {
          area: "Notes",
          text: "One-to-one meeting titles capitalize participant names consistently.",
        },
        {
          area: "Notes",
          text: "A brief opening in another language is less likely to become the meeting title.",
        },
        {
          area: "Notes",
          text: "Ready can improve an early automatic title without changing a title you wrote yourself.",
        },
        {
          area: "Tasks",
          text: "Repeated versions of a task are combined while keeping the person responsible.",
        },
        {
          area: "Tasks",
          text: "Reduced missed task updates when returning to a browser tab.",
        },
        {
          area: "Tasks",
          text: "Fixed Ready missing tasks discussed later in some short meetings.",
        },
        {
          area: "Tasks",
          text: "Fixed missed assignments when the relevant words came at the end of a sentence.",
        },
        {
          area: "Tasks",
          text: "Fixed unrelated tasks being assigned to you after you finished listing your own to-dos.",
        },
        {
          area: "Tasks",
          text: "Fixed the same task appearing twice, once with a person assigned and once without.",
        },
        {
          area: "Video",
          text: "Shared screens look less blocky when shown in a smaller window.",
        },
        {
          area: "Workspace",
          text: "New accounts joining through an invitation no longer keep an extra, unused signup workspace.",
        },
        {
          area: "Calendar",
          text: "Switching workspaces no longer reuses calendar events or preparation results from the previous workspace.",
        },
        {
          area: "Tasks",
          text: "Task lists and sidebar counts show only the active workspace’s tasks.",
        },
        {
          area: "Tasks",
          text: "New workspace members now appear in assignment menus without a page reload.",
        },
        {
          area: "Tasks",
          text: "Fixed deleted unassigned workspace tasks remaining visible for other members.",
        },
        {
          area: "Workspace",
          text: "Fixed old invitations blocking removed members from being invited back.",
        },
        {
          area: "Workspace",
          text: "Switching workspaces no longer briefly mixes the old and new content.",
        },
        {
          area: "Workspace",
          text: "If an invitation is accepted but sign-in cannot finish, Ready explains what to try next.",
        },
        {
          area: "Tasks",
          text: "Unassigned meeting tasks remain visible in Others instead of disappearing.",
        },
        {
          area: "Tasks",
          text: "Eligible meeting tasks can be reassigned back to you after moving to Others.",
        },
        {
          area: "Tasks",
          text: "Assignment menus no longer hide behind later task rows.",
        },
        {
          area: "Video",
          text: "Participants with their cameras off show initials instead of an endless loading tile.",
        },
        {
          area: "Video",
          text: "Fixed profile photos flickering or spilling outside their circles when cameras turned on or off.",
        },
        {
          area: "Notes",
          text: "Browsers that cannot copy rich formatting still receive a plain-text version.",
        },
        {
          area: "Tasks",
          text: "Ideas discussed as possibilities are less likely to appear as agreed tasks.",
        },
        {
          area: "Tasks",
          text: "Stopped the assistant’s own suggestions being treated as work someone had agreed to do.",
        },
        {
          area: "Tasks",
          text: "Ready now recognizes more ways people commit to a task in Finnish.",
        },
        {
          area: "Tasks",
          text: "Offering to help with one thing is less likely to leave you assigned to unrelated work.",
        },
      ],
      sections: [
        {
          title: "Calendars for each workspace",
          paragraphs: [
            "You can now choose which connected calendars appear in each workspace. Keep one team’s meetings and preparation separate from another project’s schedule.",
            "Open calendar settings to choose the accounts used in the current workspace. If none are selected, a prompt takes you straight to the chooser.",
          ],
        },
        {
          title: "Multiple workspaces",
          paragraphs: [
            "You can now create a workspace for each team or project and switch between them from the account menu. Each workspace has its own tasks, so switching teams also switches the work you see.",
            "Workspace roles control who can make changes. Owners manage billing and ownership, Admins help with members and settings, and Members take part in the workspace.",
          ],
        },
        {
          title: "Mine, Others, and Done",
          paragraphs: [
            "Tasks now have three views: Mine for your unfinished work, Others for shared tasks and work assigned to other people, and Done for completed tasks.",
            "Create a personal task in Mine or an unassigned shared task in Others. Profile photos and initials show who is responsible, and tasks move between views when their assignment or status changes.",
          ],
        },
        {
          title: "Copy summaries and tasks",
          paragraphs: [
            "You can now copy a meeting summary and its tasks into an email. Choose “Copy summary & tasks” from the meeting menu, or press Option + Shift + S in the meeting view.",
            "Headings, bullets, and bold task titles carry over in supported email apps. Task descriptions stay with their titles, and removed tasks are left out.",
          ],
        },
      ],
      visual: "dark-tasks",
    },
    {
      slug: "prepare-on-your-terms",
      date: "2026-07-10",
      category: "Meetings",
      title: "Meeting preparation and connected apps",
      paragraphs: [
        "You can now choose when to prepare for an upcoming meeting and how much research to include. Select a preparation option beneath the meeting and review the estimated credit cost before starting.",
        "Ready uses Parallel Web Systems to find public information about the people and companies you will meet, then brings it together in a brief. This saves you from looking up each person separately and gives you background for planning your questions.",
        "Progress updates show what has been found while the brief is being prepared.",
      ],
      improvements: [
        {
          area: "Meeting prep",
          text: "Choose a research option and review its estimated credit cost before starting.",
        },
        {
          area: "Meeting prep",
          text: "Preparation options now sit together beneath the meeting tile.",
        },
        {
          area: "Meeting prep",
          text: "Research progress now shows updates about the findings.",
        },
        {
          area: "Meetings",
          text: "Internal one-to-one meetings are made confidential automatically.",
        },
        {
          area: "Meetings",
          text: "Confidentiality controls are available during a meeting and in its notes.",
        },
        {
          area: "Workspace",
          text: "Add a workspace logo and update its details from settings.",
        },
        {
          area: "Workspace",
          text: "Manage members and email invitations from workspace settings.",
        },
        {
          area: "Workspace",
          text: "Invited teammates can accept an invitation to join the workspace.",
        },
        {
          area: "Agent",
          text: "Everyone can see when the assistant is thinking, including people who join late.",
        },
        {
          area: "Meetings",
          text: "Guests can share their screen, including share audio where the browser supports it.",
        },
        {
          area: "Notes",
          text: "Meeting summaries now consider the full transcript, including commitments made near the end.",
        },
        {
          area: "Slack",
          text: "Route meeting follow-ups to different channels by meeting type.",
        },
        {
          area: "Slack",
          text: "Connect Slack from settings.",
        },
        {
          area: "Slack",
          text: "When a delivery creates a new channel, the person who connected Slack is invited to it.",
        },
        {
          area: "Tasks",
          text: "Completed work stays in the meeting’s task list, already checked off.",
        },
        {
          area: "Tasks",
          text: "Task completion is supported by a quote from the conversation.",
        },
        {
          area: "Linear",
          text: "Preview and confirm several Linear changes together.",
        },
        {
          area: "Linear",
          text: "Improved Linear searches by topic, project, and status.",
        },
        {
          area: "Linear",
          text: "The assistant can use your shared screen to answer questions about the Linear issues you are looking at.",
        },
        {
          area: "Linear",
          text: "Confirmation panels describe the proposed change in plain language.",
        },
        {
          area: "Linear",
          text: "Successful changes close the panel and show a brief confirmation.",
        },
        {
          area: "Agent",
          text: "The assistant can inspect your shared screen when you ask about what is visible.",
        },
        {
          area: "Research",
          text: "Web research results can be shared with everyone in the room.",
        },
        {
          area: "Sign-in",
          text: "Sign-in links now work before the page finishes loading its interactive controls.",
        },
        {
          area: "Video",
          text: "Signed-in users’ background-blur preference is remembered across meetings.",
        },
        {
          area: "Video",
          text: "Participant tiles resize together to fit beside a shared screen.",
        },
        {
          area: "Video",
          text: "The screen-share fullscreen control stays within reach at the top right.",
        },
      ],
      fixes: [
        {
          area: "Meetings",
          text: "Improved coordination when participants try to start presenting at the same time.",
        },
        {
          area: "Meetings",
          text: "Fixed delayed updates making ended meetings appear active again.",
        },
        {
          area: "Video",
          text: "Camera and microphone permission requests can be retried after a failed attempt.",
        },
        {
          area: "Video",
          text: "Camera and microphone buttons correctly show when they have stopped.",
        },
        {
          area: "Notes",
          text: "Work finished during the call no longer appears as an open next step in the summary.",
        },
        {
          area: "Tasks",
          text: "Promises and partial progress are not treated as proof that a task is complete.",
        },
        {
          area: "Linear",
          text: "Fixed connection controls getting stuck while linking Linear.",
        },
        {
          area: "Linear",
          text: "Fixed the assistant being unable to use connected Linear tools in meetings with just you.",
        },
        {
          area: "Linear",
          text: "Partial failures keep the panel open and identify which changes did not complete.",
        },
        {
          area: "Linear",
          text: "Canceling a proposed action clearly confirms that no changes were made.",
        },
        {
          area: "Notes",
          text: "Fixed failed notes leaving the page loading indefinitely.",
        },
        {
          area: "Notes",
          text: "A brief problem checking progress no longer flashes an error while notes are still being prepared.",
        },
        {
          area: "Captions",
          text: "Fixed some words from phone callers missing from the written conversation when caller information was unavailable.",
        },
        {
          area: "Sign-in",
          text: "Fixed the Option + Shift + Q logout shortcut not responding on macOS.",
        },
        {
          area: "Video",
          text: "A saved blur preference arriving late no longer overrides your latest choice in the waiting room.",
        },
      ],
      sections: [
        {
          title: "Workspace members and invitations",
          paragraphs: [
            "Workspace settings now bring your team’s profile, members, and invitations together. Add a logo, update workspace details, or invite teammates by email.",
            "You can also limit access to a meeting and its notes to the people who took part. Privacy controls are available during the call and in the notes.",
          ],
        },
        {
          title: "Screen sharing for guests",
          paragraphs: [
            "Guests can now share their screen without creating an account. After the host admits you, use the meeting controls to present in a supported browser. Shared audio is available where the browser supports it.",
            "Ready also coordinates the switch between presenters when two people try to share at once.",
          ],
        },
        {
          title: "Meeting follow-ups in Slack",
          paragraphs: [
            "You can now send meeting summaries and tasks to Slack channels. Connect Slack in settings and choose where each type of meeting should go.",
            "Manage the channel choices in Connected apps to keep follow-ups where your team will see them.",
          ],
        },
        {
          title: "Completed tasks in meeting notes",
          paragraphs: [
            "Work finished during a call can now appear in the notes already checked off. Ready looks for confirmation in the conversation, keeping completed work separate from promises and partial progress.",
            "Completed tasks stay in the list, giving you a record of what was accomplished alongside the work still to do.",
          ],
        },
        {
          title: "Use Linear during meetings",
          paragraphs: [
            "You can now ask your meeting assistant to find or update Linear issues, the work items your team tracks in Linear. Connect Linear to get started, then review proposed changes before confirming them.",
            "You can approve several changes together. Ready shows which finished and keeps any unsuccessful changes available for review.",
          ],
        },
        {
          title: "People beside your presentation",
          paragraphs: [
            "Participant video windows now sit beside the shared screen, keeping faces and initials visible during a presentation. The layout adjusts to fit the people in the call.",
            "You can also ask the assistant about something on the shared screen. It can use a screenshot to help answer your question.",
          ],
        },
      ],
    },
    {
      slug: "follow-the-conversation",
      date: "2026-06-28",
      category: "Meetings",
      title: "Live captions",
      paragraphs: [
        "Live captions now keep up with speech with fewer jumps in the text. Names beside the words help you follow who said what. The live and saved versions also match more consistently.",
        "Help guides now have dedicated pages for each topic, making answers easier to find and share.",
      ],
      improvements: [
        {
          area: "Captions",
          text: "Live captions update as words are confirmed.",
        },
        {
          area: "Help",
          text: "Help articles are now together in a dedicated help area.",
        },
        {
          area: "Meeting prep",
          text: "Dates in preparation briefs now use a consistent format.",
        },
      ],
      fixes: [
        {
          area: "Calendar",
          text: "Removed the brief empty-calendar placeholder before connected events loaded.",
        },
        {
          area: "Captions",
          text: "Fixed some participants’ words missing from the written conversation.",
        },
        {
          area: "Captions",
          text: "Live captions and the saved conversation now match more consistently.",
        },
        {
          area: "Captions",
          text: "Speaker names remain visible when caption updates arrive with missing details.",
        },
        {
          area: "Tasks",
          text: "Fixed cut-off names in task assignment labels.",
        },
        {
          area: "Tasks",
          text: "Fixed meeting guests missing from the menu for assigning tasks.",
        },
      ],
    },
    {
      slug: "a-waiting-room-for-phone-callers",
      date: "2026-06-11",
      category: "Meetings",
      title: "Phone callers and background blur",
      paragraphs: [
        "Phone callers now wait for the host to admit them, just like guests joining from a browser. Hosts can accept or decline callers from the same waiting list.",
        "Once admitted, callers’ speech appears in the written conversation with a caller label. Waiting requests clear when someone hangs up or the meeting ends.",
      ],
      improvements: [
        {
          area: "Meetings",
          text: "Hosts admit or decline phone callers from the same waiting list as web guests.",
        },
        {
          area: "Meetings",
          text: "Caller labels use the available caller ID to help hosts recognize an arrival.",
        },
        {
          area: "Meetings",
          text: "Waiting requests clear when a caller hangs up or the meeting ends.",
        },
        {
          area: "Video",
          text: "The same effect works in the waiting room and the meeting.",
        },
        {
          area: "Video",
          text: "A simpler blur stays available on devices that cannot run the enhanced effect.",
        },
        {
          area: "Video",
          text: "Blur follows hair, clothing, and accessories more closely.",
        },
      ],
      fixes: [
        {
          area: "Captions",
          text: "Phone callers’ speech now appears in the live transcript.",
        },
        {
          area: "Meetings",
          text: "Phone callers no longer enter meeting audio before the host admits them.",
        },
        {
          area: "Meetings",
          text: "Failed caller admissions return to the waiting list so the host can retry.",
        },
        {
          area: "Meetings",
          text: "Fixed the meeting failing to update when people joined, left, or ended the call.",
        },
        {
          area: "Video",
          text: "Reduced flickering around the person as they move.",
        },
        {
          area: "Video",
          text: "Reduced the colored halo where the person meets the blurred background.",
        },
      ],
      sections: [
        {
          title: "Background blur",
          paragraphs: [
            "Background blur now follows hair, clothing, and movement more closely, with smoother edges and less flickering.",
            "The effect runs in your browser and works before and during a meeting. A simpler version remains available for devices that cannot run the enhanced effect.",
          ],
        },
      ],
    },
    {
      slug: "keep-your-hands-on-the-keyboard",
      date: "2026-05-29",
      category: "Tasks",
      title: "Tasks and follow-ups",
      paragraphs: [
        "You can now move through tasks, select multiple rows, and create or edit work with the keyboard. Use sections to organize longer lists, or search titles, descriptions, meetings, and section names from the task toolbar.",
        "New tasks appear immediately and stay where you put them while they save. You can keep editing without losing your place, and renamed sections no longer briefly revert to their old titles.",
        "Meeting startup is more reliable, too. Ready avoids starting the same background work twice and can keep capturing other participants if one person’s speech is temporarily unavailable.",
      ],
      improvements: [
        {
          area: "Tasks",
          text: "Drag tasks between sections and work with multiple selected rows.",
        },
        {
          area: "Tasks",
          text: "Search task titles, descriptions, meeting names, and section names from the task toolbar.",
        },
        {
          area: "Tasks",
          text: "Create and rename sections without leaving the keyboard.",
        },
        {
          area: "Tasks",
          text: "Deleting a section asks for confirmation and shows how many tasks it contains.",
        },
        {
          area: "Tasks",
          text: "Improved placement when dragging tasks above or below another row.",
        },
        {
          area: "Tasks",
          text: "Tasks from a meeting with just you and the assistant are assigned to you.",
        },
        {
          area: "Workspace",
          text: "The setup checklist remembers when you have completed your first meeting.",
        },
        {
          area: "Notes",
          text: "Meeting titles describe the topic or purpose instead of repeating an instruction or search query.",
        },
      ],
      fixes: [
        {
          area: "Meeting prep",
          text: "Fixed meeting preparation researching you as though you were an outside guest.",
        },
        {
          area: "Meeting prep",
          text: "Preparation recognizes alternate versions of your Gmail address so it does not research you as a guest.",
        },
        {
          area: "Tasks",
          text: "Fixed section titles flickering back while a rename was saved.",
        },
        {
          area: "Tasks",
          text: "Fixed saving new tasks or sections interrupting the current edit.",
        },
        {
          area: "Tasks",
          text: "Fixed new tasks jumping away from where you put them after saving.",
        },
        {
          area: "Meetings",
          text: "Prevented repeated meeting-start requests from starting the same background work twice.",
        },
        {
          area: "Captions",
          text: "Trouble capturing one person’s speech no longer stops Ready from picking up the others.",
        },
        {
          area: "Meetings",
          text: "Moving around Ready feels more responsive after leaving a meeting.",
        },
        {
          area: "Notes",
          text: "Replaced awkward generated titles such as “Find Compare Companies” with clearer topic labels.",
        },
      ],
      sections: [
        {
          title: "Meeting titles and follow-ups",
          paragraphs: [
            "Meeting titles now describe the topic rather than repeat a request. For example, a conversation about finding and comparing companies can become “Company Comparison,” making it easier to find later.",
            "In meetings with just you and the assistant, follow-up tasks are now assigned to you. Immediate requests such as “look this up” stay separate from work to do after the call.",
            "The setup checklist remembers when you finish your first meeting, so you can move on to the next step.",
          ],
        },
      ],
    },
    {
      slug: "introducing-ready",
      date: "2026-05-18",
      category: "Launch",
      title: "Introducing Ready: AI-native meetings",
      paragraphs: [
        "Introducing Ready, a meeting app with AI built into the conversation. Meet over video, share your screen, and ask for help during the call. Ready turns the conversation into notes and tasks you can return to afterward.",
        "Start a meeting and share the link to invite someone. Live captions show who said what, and the written conversation stays with your notes so you can check a detail later.",
        "Need to look something up? Ask the assistant and follow its web research in a panel beside the call. Progress stays visible as it searches, with a retry if a temporary problem gets in the way.",
        "After the meeting, come back to a summary, decisions, and follow-up tasks. Requests for help during the call stay separate from work to do afterward. Completed tasks and follow-ups stay saved when you reopen the meeting.",
      ],
      improvements: [],
      fixes: [],
    },
  ],
};

export const releases = RELEASE_CONTENT.releases;

export function formatReleaseDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

export function releasePath(release: Pick<Release, "date" | "slug">): string {
  return `/updates/${release.date}-${release.slug}`;
}
