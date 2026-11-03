"use client";

import { type Dispatch, type ReactNode, type RefObject, type SetStateAction, useEffect, useRef, useState } from "react";

import { ReadyLogo } from "../ready-logo";

import {
  createDemoRooms,
  demoMeetings,
  demoPeople,
  demoPortraits,
  type DemoRoom,
  demoUpcoming,
  type Feature,
  features,
  makeMinutes,
} from "./data";

import styles from "./demo-spaces.module.css";

type View = "Board" | "Upcoming" | "Past meetings" | "People" | "Tasks" | "Settings";
const featureCopy: Record<Feature, string> = {
  Board: "Private rooms for your board to prepare for meetings, review minutes, and follow up on decisions.",
  Sales: "A shared room for proposals, resources, and next steps with your customers.",
  Recruiting: "A private room for candidate materials, interview feedback, and hiring decisions.",
  Partners: "Manage your partnership relationships, keep track of shared priorities, and follow up on next steps.",
};

const GENERATION_FINAL_STEP = 2;
const GENERATION_STEP_DELAY_MS = 850;
const NOTICE_CLEAR_DELAY_MS = 5000;
const AGENDA_INDEX_PAD_WIDTH = 2;
const DEMO_SPACES_ERRORS = { demoRoomsUnavailable: "Demo rooms are unavailable" } as const;
const DEMO_SPACES_NOTICES = {
  demoReset: "Demo reset. All changes are local to this page.",
  sampleDraftMinutes: "Sample draft minutes prepared. No meeting or AI service was started.",
  demoSettingsSaved: "Demo settings saved for this page session.",
} as const;
const GENERATION_STATUS_MESSAGES = [
  "Reviewing the sample meeting…",
  "Preparing follow-up tasks…",
  "Drafting meeting minutes…",
] as const;
const DEMO_SPACES_COPY = {
  readySpacesTitle: "Ready Spaces",
  interactiveDemoTag: "Interactive demo",
  sampleDataHint: "Sample data · Changes reset on reload",
  resetDemoButton: "Reset demo",
  readyBrand: "Ready",
  workspaceMark: "R",
  readyWorkspaceTitle: "Ready workspace",
  demoWorkspaceSubtitle: "Demo workspace",
  workspaceNavLabel: "Workspace",
  settingsNav: "Settings",
  demoAccountName: "Avery",
  demoAccountSubtitle: "Demo account",
  boardsHeading: "Boards",
  boardRoomsNote: "Private rooms for decisions that move things forward.",
  settingsHeading: "Settings",
  featuresNavLabel: "Features",
  settingsListNote: "Explore feature settings with sample rooms and people.",
  breadcrumbBoard: "Board",
  breadcrumbSeparator: "/",
  breadcrumbMeetingMinutes: "Meeting minutes",
  breadcrumbSettings: "Settings",
  backToBoardRoom: "‹ Back to board room",
  backToAllBoardRooms: "‹ All board rooms",
  followUpTasksSection: "Follow-up tasks",
  meetingMinutesSection: "Meeting minutes",
  editedDraftHeading: "Edited draft",
  boardOfDirectors: "Board of directors",
  nextBoardMeetingSection: "Next board meeting",
  nextMeetingMonthAbbrev: "OCT",
  nextMeetingDay: "29",
  defaultNextMeetingTitle: "October board meeting",
  nextMeetingSchedule: "Thursday, October 29 · 10:00–11:00",
  generationPreviewButton: "Preview minutes generation",
  generationPreparingButton: "Preparing…",
  generationIdleHint: "See a sample meeting turn into draft minutes.",
  agendaSection: "Agenda",
  materialsSection: "Materials",
  boardPackTitle: "Board pack · October 2026",
  boardPackSummary: "Forecast, rollout update, and proposed decisions",
  boardPackView: "View",
  pastBoardMeetingsSection: "Past board meetings",
  companySection: "Company",
  companyNameField: "Company name",
  countryField: "Country",
  boardMembersSection: "Board members",
  chairRole: "Chair",
  directorRole: "Director",
  governanceDocumentsSection: "Governance documents",
  articlesOfAssociation: "▤ Articles of association",
  viewSampleDocument: "View sample",
  exampleDocumentsNote: "Example documents are included in this demo.",
  saveAndOpenBoardRoom: "Save and open board room",
  boardRoomsSection: "Board rooms",
  createBoardRoom: "+ Create board room",
  membersSuffix: "members",
  manageRoom: "Manage ›",
  createRoomDisabled: "+ Create room",
  waitlistJoined: "You're on the waitlist",
  availableByInvitation: "Available by invitation",
  requestAccess: "Request access",
  upcomingHeading: "Upcoming",
  upcomingSubtitle: "Sample calendar events from the Ready homepage demo.",
  exploreBoardMeetingSetup: "Explore Board meeting setup",
  pastMeetingsSubtitle: "Sample meetings from the Ready homepage demo.",
  backToAllMeetings: "‹ All meetings",
  peopleHeading: "People",
  peopleSubtitle: "Familiar faces from the public Ready demo.",
  tasksHeading: "Tasks",
  tasksSubtitle: "Follow up on the decisions made in your board rooms.",
  createBoardRoomDialogTitle: "Create board room",
  chooseSampleMeetingDialogTitle: "Choose a sample meeting",
  documentDialogTitle: "Board pack · October 2026",
  illustrativeDocumentLabel: "Illustrative document · Demo data",
  sampleMeetingTime: "October 29, 2026 · 10:00–11:00",
  boardRoomCountrySuffix: "· Board of directors",
  yourRoomsPlaceholderSuffix: "rooms will appear here.",
  yourRoomsPlaceholderPrefix: "Your",
  boardSettingsAriaLabel: "Board settings",
  changeNextMeetingAriaLabel: "Change next board meeting",
  readyHomeAriaLabel: "Ready homepage",
  draftMinutesField: "Draft minutes",
  newAgendaItemAriaLabel: "New agenda item",
  addAgendaPlaceholder: "Add an agenda item…",
  addAgendaButton: "Add",
  closeDialogAriaLabel: "Close dialog",
  companyNamePlaceholder: "Company name",
  createDemoRoomButton: "Create demo room",
  meetingMinutesBadge: "minutes",
  boardMembersMeetingNote: "board members · Ready video meeting",
  changeMeetingButton: "Change meeting",
  documentTileIcon: "▤",
  listChevron: "›",
  calendarAddIcon: "+",
  countryMembersSeparator: " · ",
} as const;
const CALENDAR_SAMPLE_MEETINGS = [
  "October board meeting",
  "Strategy and budget review",
  "Quarterly governance review",
] as const;
const WORKSPACE_NAV_VIEWS: View[] = ["Upcoming", "Past meetings", "People", "Tasks", "Board"];
function hasNonEmptyText(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== "";
}
function joinModuleClasses(...parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== "").join(" ");
}
function featureRoomsSectionTitle(feature: Feature): string {
  return `${feature === "Partners" ? "Partner" : feature} rooms`;
}
function waitlistSavedMessage(feature: Feature): string {
  return `Your sample request for ${feature} access is saved in this demo only.`;
}
function exploreFeatureAccessMessage(feature: Feature): string {
  return `Explore how ${feature.toLowerCase()} access will work.`;
}
function yourFeatureRoomsMessage(feature: Feature): string {
  return `${DEMO_SPACES_COPY.yourRoomsPlaceholderPrefix} ${feature.toLowerCase()} ${DEMO_SPACES_COPY.yourRoomsPlaceholderSuffix}`;
}
function settingsForRoomAriaLabel(roomName: string): string {
  return `Settings for ${roomName}`;
}
function includeMemberAriaLabel(name: string): string {
  return `Include ${name}`;
}
function applyRoomUpdate(input: {
  setRooms: Dispatch<SetStateAction<DemoRoom[]>>;
  id: string;
  change: (item: DemoRoom) => DemoRoom;
}): void {
  input.setRooms((current) => current.map((item) => (item.id === input.id ? input.change(item) : item)));
}

function buildDemoSpacesActions(input: {
  setRooms: Dispatch<SetStateAction<DemoRoom[]>>;
  setView: Dispatch<SetStateAction<View>>;
  setMeetingId: Dispatch<SetStateAction<string | null>>;
  setEditRoom: Dispatch<SetStateAction<string | null>>;
  setSampleMeeting: Dispatch<SetStateAction<string | null>>;
  setIsEditingMinutes: Dispatch<SetStateAction<boolean>>;
  setRoomId: Dispatch<SetStateAction<string>>;
  setRequests: Dispatch<SetStateAction<Feature[]>>;
  setNextTitles: Dispatch<SetStateAction<Record<string, string>>>;
  setGeneration: Dispatch<SetStateAction<{ roomId: string; title: string; step: number } | null>>;
  setNotice: Dispatch<SetStateAction<string>>;
  feature: Feature;
}) {
  function updateRoom(updateInput: { id: string; change: (item: DemoRoom) => DemoRoom }) {
    applyRoomUpdate({ setRooms: input.setRooms, id: updateInput.id, change: updateInput.change });
  }
  function go(next: View) {
    input.setView(next);
    input.setMeetingId(null);
    input.setEditRoom(null);
    input.setSampleMeeting(null);
    input.setIsEditingMinutes(false);
  }
  function reset() {
    input.setRooms(createDemoRooms());
    input.setRoomId("meridian");
    go("Board");
    input.setRequests([]);
    input.setNextTitles({});
    input.setGeneration(null);
    input.setNotice(DEMO_SPACES_NOTICES.demoReset);
  }
  function requestAccess() {
    input.setRequests((current) => (current.includes(input.feature) ? current : [...current, input.feature]));
  }

  return { updateRoom, go, reset, requestAccess };
}

function getDemoSpacesRoomContext(input: {
  rooms: DemoRoom[];
  roomId: string;
  meetingId: string | null;
  editRoom: string | null;
  sampleMeeting: string | null;
}): {
  room: DemoRoom;
  meeting: DemoRoom["minutes"][number] | undefined;
  settingsRoom: DemoRoom | undefined;
  preview: (typeof demoMeetings)[number] | undefined;
} {
  const room = input.rooms.find((item) => item.id === input.roomId) ?? input.rooms[0];
  if (room === undefined) {
    throw new Error(DEMO_SPACES_ERRORS.demoRoomsUnavailable);
  }

  return {
    room,
    meeting: room.minutes.find((item) => item.id === input.meetingId),
    settingsRoom: input.rooms.find((item) => item.id === input.editRoom),
    preview: demoMeetings.find((item) => item.id === input.sampleMeeting),
  };
}
function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    Board: "M3 5h18v14H3z M3 10h18 M8 10v9",
    Settings: "M9 4h6l1 3 3 1v8l-3 1-1 3H9l-1-3-3-1V8l3-1z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
    Upcoming: "M5 4h14v17H5z M8 2v4 M16 2v4 M5 9h14",
    "Past meetings": "M12 3a9 9 0 1 1-9 9 M3 3v6h6 M12 7v5l3 2",
    People:
      "M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 7 M22 21v-3a4 4 0 0 0-3-4",
    Tasks: "m4 6 2 2 4-4 M13 6h7 M4 14l2 2 4-4 M13 14h7 M13 20h7",
  };

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.Board} />
    </svg>
  );
}
function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionTitle}>
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
function Avatar({ name }: { name: string }) {
  const portrait = demoPortraits[name];

  return hasNonEmptyText(portrait) ? (
    <img className={styles.avatar} src={portrait} alt="" />
  ) : (
    <span className={styles.avatar}>
      {name
        .split(" ")
        .map((n) => n[0])
        .join("")}
    </span>
  );
}
type DemoSpacesModal = "new-room" | "calendar" | "document" | null;

function DemoSpacesDocumentModalBody() {
  return (
    <article className={styles.minutes}>
      <p className={styles.muted}>{DEMO_SPACES_COPY.illustrativeDocumentLabel}</p>
    </article>
  );
}

type DemoSpacesDialogProps = {
  modalRef: RefObject<HTMLDialogElement | null>;
  modal: DemoSpacesModal;
  setModal: (value: DemoSpacesModal) => void;
  newName: string;
  setNewName: (value: string) => void;
  rooms: DemoRoom[];
  setRooms: Dispatch<SetStateAction<DemoRoom[]>>;
  setEditRoom: (value: string | null) => void;
  room: DemoRoom;
  setNextTitles: Dispatch<SetStateAction<Record<string, string>>>;
};

function DemoSpacesDialog({
  modalRef,
  modal,
  setModal,
  newName,
  setNewName,
  rooms,
  setRooms,
  setEditRoom,
  room,
  setNextTitles,
}: DemoSpacesDialogProps) {
  return (
    <dialog
      ref={modalRef}
      className={styles.dialog}
      onCancel={() => setModal(null)}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setModal(null);
        }
      }}
    >
      <div className={styles.dialogHeader}>
        <h2>
          {modal === "new-room"
            ? DEMO_SPACES_COPY.createBoardRoomDialogTitle
            : modal === "calendar"
              ? DEMO_SPACES_COPY.chooseSampleMeetingDialogTitle
              : DEMO_SPACES_COPY.documentDialogTitle}
        </h2>
        <button aria-label={DEMO_SPACES_COPY.closeDialogAriaLabel} onClick={() => setModal(null)}>
          ×
        </button>
      </div>
      {modal === "new-room" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!hasNonEmptyText(newName.trim())) {
              return;
            }
            const id = `room-${rooms.length + 1}`;
            setRooms((current) => [
              ...current,
              {
                id,
                name: newName.trim(),
                country: "Finland",
                members: ["Avery", "Jordan"],
                agenda: ["Business review", "Budget and next steps"],
                tasks: [],
                minutes: [],
              },
            ]);
            setEditRoom(id);
            setModal(null);
          }}
        >
          <label className={styles.field}>
            {DEMO_SPACES_COPY.companyNameField}
            <input
              autoFocus
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={DEMO_SPACES_COPY.companyNamePlaceholder}
            />
          </label>
          <button className={styles.primary}>{DEMO_SPACES_COPY.createDemoRoomButton}</button>
        </form>
      ) : null}
      {modal === "calendar"
        ? CALENDAR_SAMPLE_MEETINGS.map((title) => (
            <button
              className={styles.meetingRow}
              key={title}
              onClick={() => {
                setNextTitles((current) => ({ ...current, [room.id]: title }));
                setModal(null);
              }}
            >
              <span>
                <strong>{title}</strong>
                <small>{DEMO_SPACES_COPY.sampleMeetingTime}</small>
              </span>
              <span>{DEMO_SPACES_COPY.calendarAddIcon}</span>
            </button>
          ))
        : null}
      {modal === "document" ? <DemoSpacesDocumentModalBody /> : null}
    </dialog>
  );
}

type RoomUpdater = (input: { id: string; change: (item: DemoRoom) => DemoRoom }) => void;

type DemoSpacesModel = {
  rooms: DemoRoom[];
  setRooms: Dispatch<SetStateAction<DemoRoom[]>>;
  roomId: string;
  setRoomId: (id: string) => void;
  view: View;
  meetingId: string | null;
  setMeetingId: (id: string | null) => void;
  feature: Feature;
  setFeature: (feature: Feature) => void;
  editRoom: string | null;
  setEditRoom: (id: string | null) => void;
  requests: Feature[];
  generation: { roomId: string; title: string; step: number } | null;
  setGeneration: Dispatch<SetStateAction<{ roomId: string; title: string; step: number } | null>>;
  agendaInput: string;
  setAgendaInput: (value: string) => void;
  modal: DemoSpacesModal;
  setModal: (value: DemoSpacesModal) => void;
  newName: string;
  setNewName: (value: string) => void;
  notice: string;
  setNotice: Dispatch<SetStateAction<string>>;
  isEditingMinutes: boolean;
  setIsEditingMinutes: (value: boolean) => void;
  draft: string;
  setDraft: (value: string) => void;
  sampleMeeting: string | null;
  setSampleMeeting: (id: string | null) => void;
  nextTitles: Record<string, string>;
  setNextTitles: Dispatch<SetStateAction<Record<string, string>>>;
  modalRef: RefObject<HTMLDialogElement | null>;
  room: DemoRoom;
  meeting: DemoRoom["minutes"][number] | undefined;
  settingsRoom: DemoRoom | undefined;
  preview: (typeof demoMeetings)[number] | undefined;
  updateRoom: RoomUpdater;
  go: (next: View) => void;
  reset: () => void;
  requestAccess: () => void;
};

function useDemoSpacesEffects(input: {
  modal: DemoSpacesModal;
  modalRef: RefObject<HTMLDialogElement | null>;
  generation: DemoSpacesModel["generation"];
  setGeneration: DemoSpacesModel["setGeneration"];
  setRooms: DemoSpacesModel["setRooms"];
  setRoomId: DemoSpacesModel["setRoomId"];
  setMeetingId: DemoSpacesModel["setMeetingId"];
  setView: Dispatch<SetStateAction<View>>;
  setNotice: DemoSpacesModel["setNotice"];
  notice: string;
}): void {
  const { modal, modalRef, generation, setGeneration, setRooms, setRoomId, setMeetingId, setView, setNotice, notice } =
    input;

  useEffect(() => {
    if (modal !== null) {
      modalRef.current?.showModal();
    } else {
      modalRef.current?.close();
    }
  }, [modal, modalRef]);

  useEffect(() => {
    if (generation === null) {
      return;
    }
    const timeout = window.setTimeout(() => {
      if (generation.step < GENERATION_FINAL_STEP) {
        setGeneration({ ...generation, step: generation.step + 1 });
      } else {
        const id = `${generation.roomId}-generated`;
        setRooms((current) =>
          current.map((item) =>
            item.id === generation.roomId
              ? {
                  ...item,
                  minutes: [
                    makeMinutes({ room: item, id, title: generation.title, date: "October 29, 2026" }),
                    ...item.minutes.filter((m) => m.id !== id),
                  ],
                }
              : item,
          ),
        );
        setGeneration(null);
        setRoomId(generation.roomId);
        setMeetingId(id);
        setView("Board");
        setNotice(DEMO_SPACES_NOTICES.sampleDraftMinutes);
      }
    }, GENERATION_STEP_DELAY_MS);

    return () => window.clearTimeout(timeout);
  }, [generation, setGeneration, setMeetingId, setNotice, setRoomId, setRooms, setView]);

  useEffect(() => {
    if (notice === "") {
      return;
    }
    const timeout = window.setTimeout(() => setNotice(""), NOTICE_CLEAR_DELAY_MS);

    return () => window.clearTimeout(timeout);
  }, [notice, setNotice]);
}

function useDemoSpacesModel(): DemoSpacesModel {
  const [rooms, setRooms] = useState(createDemoRooms);
  const [roomId, setRoomId] = useState("meridian");
  const [view, setView] = useState<View>("Board");
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [feature, setFeature] = useState<Feature>("Board");
  const [editRoom, setEditRoom] = useState<string | null>(null);
  const [requests, setRequests] = useState<Feature[]>([]);
  const [generation, setGeneration] = useState<{
    roomId: string;
    title: string;
    step: number;
  } | null>(null);
  const [agendaInput, setAgendaInput] = useState("");
  const [modal, setModal] = useState<"new-room" | "calendar" | "document" | null>(null);
  const [newName, setNewName] = useState("");
  const [notice, setNotice] = useState("");
  const [isEditingMinutes, setIsEditingMinutes] = useState(false);
  const [draft, setDraft] = useState("");
  const [sampleMeeting, setSampleMeeting] = useState<string | null>(null);
  const [nextTitles, setNextTitles] = useState<Record<string, string>>({});
  const modalRef = useRef<HTMLDialogElement>(null);
  const { room, meeting, settingsRoom, preview } = getDemoSpacesRoomContext({
    rooms,
    roomId,
    meetingId,
    editRoom,
    sampleMeeting,
  });
  const { updateRoom, go, reset, requestAccess } = buildDemoSpacesActions({
    setRooms,
    setView,
    setMeetingId,
    setEditRoom,
    setSampleMeeting,
    setIsEditingMinutes,
    setRoomId,
    setRequests,
    setNextTitles,
    setGeneration,
    setNotice,
    feature,
  });
  useDemoSpacesEffects({
    modal,
    modalRef,
    generation,
    setGeneration,
    setRooms,
    setRoomId,
    setMeetingId,
    setView,
    setNotice,
    notice,
  });

  return {
    rooms,
    setRooms,
    roomId,
    setRoomId,
    view,
    meetingId,
    setMeetingId,
    feature,
    setFeature,
    editRoom,
    setEditRoom,
    requests,
    generation,
    setGeneration,
    agendaInput,
    setAgendaInput,
    modal,
    setModal,
    newName,
    setNewName,
    notice,
    setNotice,
    isEditingMinutes,
    setIsEditingMinutes,
    draft,
    setDraft,
    sampleMeeting,
    setSampleMeeting,
    nextTitles,
    setNextTitles,
    modalRef,
    room,
    meeting,
    settingsRoom,
    preview,
    updateRoom,
    go,
    reset,
    requestAccess,
  };
}

function DemoSpacesBoardRoomSettingsDetail(input: {
  settingsRoom: DemoRoom;
  updateRoom: RoomUpdater;
  setEditRoom: (id: string | null) => void;
  setModal: (value: DemoSpacesModal) => void;
  setRoomId: (id: string) => void;
  go: (next: View) => void;
  setNotice: Dispatch<SetStateAction<string>>;
}) {
  const { settingsRoom } = input;

  return (
    <>
      <button className={styles.back} onClick={() => input.setEditRoom(null)}>
        {DEMO_SPACES_COPY.backToAllBoardRooms}
      </button>
      <Section title={DEMO_SPACES_COPY.companySection}>
        <label className={styles.field}>
          {DEMO_SPACES_COPY.companyNameField}
          <input
            value={settingsRoom.name}
            onChange={(e) => input.updateRoom({ id: settingsRoom.id, change: (r) => ({ ...r, name: e.target.value }) })}
          />
        </label>
        <label className={styles.field}>
          {DEMO_SPACES_COPY.countryField}
          <select
            value={settingsRoom.country}
            onChange={(e) =>
              input.updateRoom({ id: settingsRoom.id, change: (r) => ({ ...r, country: e.target.value }) })
            }
          >
            <option>Finland</option>
            <option>United States</option>
            <option>United Kingdom</option>
            <option>Sweden</option>
          </select>
        </label>
      </Section>
      <Section title={DEMO_SPACES_COPY.boardMembersSection}>
        {demoPeople.map((name) => (
          <label className={styles.memberRow} key={name}>
            <Avatar name={name} />
            <span>
              {name}
              <small>
                {name === DEMO_SPACES_COPY.demoAccountName ? DEMO_SPACES_COPY.chairRole : DEMO_SPACES_COPY.directorRole}
              </small>
            </span>
            <input
              aria-label={includeMemberAriaLabel(name)}
              type="checkbox"
              checked={settingsRoom.members.includes(name)}
              onChange={(e) =>
                input.updateRoom({
                  id: settingsRoom.id,
                  change: (r) => ({
                    ...r,
                    members: e.target.checked ? [...r.members, name] : r.members.filter((n) => n !== name),
                  }),
                })
              }
            />
          </label>
        ))}
      </Section>
      <Section title={DEMO_SPACES_COPY.governanceDocumentsSection}>
        <button className={styles.document} onClick={() => input.setModal("document")}>
          {DEMO_SPACES_COPY.articlesOfAssociation} <span>{DEMO_SPACES_COPY.viewSampleDocument}</span>
        </button>
        <p className={styles.muted}>{DEMO_SPACES_COPY.exampleDocumentsNote}</p>
      </Section>
      <button
        className={styles.primary}
        onClick={() => {
          input.setRoomId(settingsRoom.id);
          input.go("Board");
          input.setNotice(DEMO_SPACES_NOTICES.demoSettingsSaved);
        }}
      >
        {DEMO_SPACES_COPY.saveAndOpenBoardRoom}
      </button>
    </>
  );
}

function DemoSpacesBoardRoomsSettingsList(input: {
  rooms: DemoRoom[];
  setEditRoom: (id: string | null) => void;
  setNewName: (value: string) => void;
  setModal: (value: DemoSpacesModal) => void;
}) {
  return (
    <Section
      title={DEMO_SPACES_COPY.boardRoomsSection}
      action={
        <button
          onClick={() => {
            input.setNewName("");
            input.setModal("new-room");
          }}
        >
          {DEMO_SPACES_COPY.createBoardRoom}
        </button>
      }
    >
      {input.rooms.map((item) => (
        <button className={styles.meetingRow} key={item.id} onClick={() => input.setEditRoom(item.id)}>
          <span>
            <strong>{item.name}</strong>
            <small>
              {item.country}
              {DEMO_SPACES_COPY.countryMembersSeparator}
              {item.members.length} {DEMO_SPACES_COPY.membersSuffix}
            </small>
          </span>
          <span>{DEMO_SPACES_COPY.manageRoom}</span>
        </button>
      ))}
    </Section>
  );
}

function DemoSpacesNonBoardFeatureSettings(input: {
  feature: Feature;
  requests: Feature[];
  requestAccess: () => void;
}) {
  return (
    <>
      <Section
        title={featureRoomsSectionTitle(input.feature)}
        action={<button disabled>{DEMO_SPACES_COPY.createRoomDisabled}</button>}
      >
        <div className={styles.placeholder}>
          <Icon name={input.feature === "Recruiting" ? "People" : "Board"} />
          <p>{yourFeatureRoomsMessage(input.feature)}</p>
        </div>
      </Section>
      <div className={styles.waitlist}>
        <Icon name="Board" />
        <h2>
          {input.requests.includes(input.feature)
            ? DEMO_SPACES_COPY.waitlistJoined
            : DEMO_SPACES_COPY.availableByInvitation}
        </h2>
        <p>
          {input.requests.includes(input.feature)
            ? waitlistSavedMessage(input.feature)
            : exploreFeatureAccessMessage(input.feature)}
        </p>
        {!input.requests.includes(input.feature) ? (
          <button className={styles.primary} onClick={input.requestAccess}>
            {DEMO_SPACES_COPY.requestAccess}
          </button>
        ) : null}
      </div>
    </>
  );
}

function DemoSpacesSettingsMainView(input: {
  feature: Feature;
  settingsRoom: DemoRoom | undefined;
  rooms: DemoRoom[];
  requests: Feature[];
  updateRoom: RoomUpdater;
  setEditRoom: (id: string | null) => void;
  setModal: (value: DemoSpacesModal) => void;
  setNewName: (value: string) => void;
  setRoomId: (id: string) => void;
  go: (next: View) => void;
  setNotice: Dispatch<SetStateAction<string>>;
  requestAccess: () => void;
}) {
  return (
    <div className={styles.content}>
      <div className={styles.breadcrumb}>
        {DEMO_SPACES_COPY.breadcrumbSettings} <span>{DEMO_SPACES_COPY.breadcrumbSeparator}</span> {input.feature}
      </div>
      <header className={styles.pageHeader}>
        <h1>{input.settingsRoom !== undefined ? input.settingsRoom.name : input.feature}</h1>
        <p>{featureCopy[input.feature]}</p>
      </header>
      {input.feature === "Board" ? (
        input.settingsRoom !== undefined ? (
          <DemoSpacesBoardRoomSettingsDetail
            settingsRoom={input.settingsRoom}
            updateRoom={input.updateRoom}
            setEditRoom={input.setEditRoom}
            setModal={input.setModal}
            setRoomId={input.setRoomId}
            go={input.go}
            setNotice={input.setNotice}
          />
        ) : (
          <DemoSpacesBoardRoomsSettingsList
            rooms={input.rooms}
            setEditRoom={input.setEditRoom}
            setNewName={input.setNewName}
            setModal={input.setModal}
          />
        )
      ) : (
        <DemoSpacesNonBoardFeatureSettings
          feature={input.feature}
          requests={input.requests}
          requestAccess={input.requestAccess}
        />
      )}
    </div>
  );
}

function DemoSpacesPastMeetingsView(input: {
  view: View;
  preview: (typeof demoMeetings)[number] | undefined;
  setSampleMeeting: (id: string | null) => void;
}) {
  return (
    <div className={styles.content}>
      <header className={styles.pageHeader}>
        <h1>{input.view}</h1>
        <p>{DEMO_SPACES_COPY.pastMeetingsSubtitle}</p>
      </header>
      {input.preview !== undefined ? (
        <>
          <button className={styles.back} onClick={() => input.setSampleMeeting(null)}>
            {DEMO_SPACES_COPY.backToAllMeetings}
          </button>
          <h2>{input.preview.title}</h2>
          <div className={styles.metadata}>
            {input.preview.participants.map((person) => (
              <span key={person.name}>{person.name}</span>
            ))}
          </div>
          <article className={styles.minutes}>
            {input.preview.notes.map((note, index) => (
              <section key={index}>
                <h3>{note.heading}</h3>
                {note.bullets.map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </section>
            ))}
          </article>
        </>
      ) : (
        demoMeetings.map((item) => (
          <button className={styles.meetingRow} key={item.id} onClick={() => input.setSampleMeeting(item.id)}>
            <span>
              <strong>{item.title}</strong>
              <small>{item.participants.map((p) => p.name).join(", ")}</small>
            </span>
            <span>{DEMO_SPACES_COPY.listChevron}</span>
          </button>
        ))
      )}
    </div>
  );
}

function DemoSpacesPeopleView(input: { rooms: DemoRoom[] }) {
  return (
    <div className={styles.content}>
      <header className={styles.pageHeader}>
        <h1>{DEMO_SPACES_COPY.peopleHeading}</h1>
        <p>{DEMO_SPACES_COPY.peopleSubtitle}</p>
      </header>
      {demoPeople.map((name) => (
        <div className={styles.memberRow} key={name}>
          <Avatar name={name} />
          <span>
            <strong>{name}</strong>
            <small>
              {input.rooms
                .filter((r) => r.members.includes(name))
                .map((r) => r.name)
                .join(" · ")}
            </small>
          </span>
        </div>
      ))}
    </div>
  );
}

function DemoSpacesTasksView(input: { rooms: DemoRoom[]; updateRoom: RoomUpdater }) {
  return (
    <div className={styles.content}>
      <header className={styles.pageHeader}>
        <h1>{DEMO_SPACES_COPY.tasksHeading}</h1>
        <p>{DEMO_SPACES_COPY.tasksSubtitle}</p>
      </header>
      {input.rooms.map((item) => (
        <Section key={item.id} title={item.name}>
          {item.tasks.map((task) => (
            <label className={styles.task} key={task.id}>
              <input
                type="checkbox"
                checked={task.isDone}
                onChange={() =>
                  input.updateRoom({
                    id: item.id,
                    change: (r) => ({
                      ...r,
                      tasks: r.tasks.map((t) => (t.id === task.id ? { ...t, isDone: !t.isDone } : t)),
                    }),
                  })
                }
              />
              <span className={task.isDone ? styles.completed : ""}>
                {task.title}
                <small>{task.owner}</small>
              </span>
            </label>
          ))}
        </Section>
      ))}
    </div>
  );
}

function DemoSpacesUpcomingView(input: { go: (next: View) => void; setModal: (value: DemoSpacesModal) => void }) {
  return (
    <div className={styles.content}>
      <header className={styles.pageHeader}>
        <h1>{DEMO_SPACES_COPY.upcomingHeading}</h1>
        <p>{DEMO_SPACES_COPY.upcomingSubtitle}</p>
      </header>
      {demoUpcoming.map((item) => (
        <Section key={item.id} title={item.title}>
          <p className={styles.muted}>{item.participants.join(" · ")}</p>
          <button
            onClick={() => {
              input.go("Board");
              input.setModal("calendar");
            }}
          >
            {DEMO_SPACES_COPY.exploreBoardMeetingSetup}
          </button>
        </Section>
      ))}
    </div>
  );
}

function DemoSpacesMeetingMinutesSection(input: {
  room: DemoRoom;
  meeting: DemoRoom["minutes"][number];
  isEditingMinutes: boolean;
  setIsEditingMinutes: (value: boolean) => void;
  draft: string;
  setDraft: (value: string) => void;
  updateRoom: RoomUpdater;
}) {
  const { room, meeting } = input;

  return (
    <Section
      title={DEMO_SPACES_COPY.meetingMinutesSection}
      action={
        <div className={styles.inline}>
          <button
            onClick={() => {
              input.setIsEditingMinutes(!input.isEditingMinutes);
              input.setDraft(meeting.sections.map((s) => `${s.heading}\n${s.text}`).join("\n\n"));
            }}
          >
            {input.isEditingMinutes ? "Cancel" : "Edit draft"}
          </button>
          <button
            disabled={meeting.status === "Approved"}
            onClick={() =>
              input.updateRoom({
                id: room.id,
                change: (item) => ({
                  ...item,
                  minutes: item.minutes.map((m) => (m.id === meeting.id ? { ...m, status: "Approved" } : m)),
                }),
              })
            }
          >
            {meeting.status === "Approved" ? "Approved" : "Approve draft"}
          </button>
        </div>
      }
    >
      {input.isEditingMinutes ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            input.updateRoom({
              id: room.id,
              change: (item) => ({
                ...item,
                minutes: item.minutes.map((m) =>
                  m.id === meeting.id
                    ? {
                        ...m,
                        status: "Draft",
                        sections: [{ heading: DEMO_SPACES_COPY.editedDraftHeading, text: input.draft }],
                      }
                    : m,
                ),
              }),
            });
            input.setIsEditingMinutes(false);
          }}
        >
          <label className={styles.field}>
            {DEMO_SPACES_COPY.draftMinutesField}
            <textarea
              aria-label={DEMO_SPACES_COPY.draftMinutesField}
              value={input.draft}
              onChange={(e) => input.setDraft(e.target.value)}
              rows={20}
            />
          </label>
          <button className={styles.primary}>Save draft</button>
        </form>
      ) : (
        <article className={styles.minutes}>
          {meeting.sections.map((section, index) => (
            <section key={index}>
              <h3>{section.heading}</h3>
              <p>{section.text}</p>
            </section>
          ))}
        </article>
      )}
    </Section>
  );
}

function DemoSpacesBoardMeetingDetail(input: {
  room: DemoRoom;
  meeting: DemoRoom["minutes"][number];
  setMeetingId: (id: string | null) => void;
  setIsEditingMinutes: (value: boolean) => void;
  isEditingMinutes: boolean;
  draft: string;
  setDraft: (value: string) => void;
  updateRoom: RoomUpdater;
}) {
  const { room, meeting } = input;

  return (
    <>
      <button
        className={styles.back}
        onClick={() => {
          input.setMeetingId(null);
          input.setIsEditingMinutes(false);
        }}
      >
        {DEMO_SPACES_COPY.backToBoardRoom}
      </button>
      <header className={styles.pageHeader}>
        <h1>{meeting.title}</h1>
        <div className={styles.metadata}>
          <span>{meeting.date}</span>
          <span className={styles.badge}>
            {meeting.status} {DEMO_SPACES_COPY.meetingMinutesBadge}
          </span>
        </div>
        <div className={styles.members}>
          {room.members.map((name) => (
            <span key={name}>
              <Avatar name={name} />
              {name}
            </span>
          ))}
        </div>
      </header>
      <Section title={DEMO_SPACES_COPY.followUpTasksSection}>
        {room.tasks.map((task) => (
          <label className={styles.task} key={task.id}>
            <input
              type="checkbox"
              checked={task.isDone}
              onChange={() =>
                input.updateRoom({
                  id: room.id,
                  change: (item) => ({
                    ...item,
                    tasks: item.tasks.map((t) => (t.id === task.id ? { ...t, isDone: !t.isDone } : t)),
                  }),
                })
              }
            />
            <span className={task.isDone ? styles.completed : ""}>
              {task.title}
              <small>{task.owner}</small>
            </span>
          </label>
        ))}
      </Section>
      <DemoSpacesMeetingMinutesSection
        room={room}
        meeting={meeting}
        isEditingMinutes={input.isEditingMinutes}
        setIsEditingMinutes={input.setIsEditingMinutes}
        draft={input.draft}
        setDraft={input.setDraft}
        updateRoom={input.updateRoom}
      />
    </>
  );
}

function DemoSpacesBoardRoomOverview(input: {
  room: DemoRoom;
  go: (next: View) => void;
  setFeature: (feature: Feature) => void;
  setEditRoom: (id: string | null) => void;
  setModal: (value: DemoSpacesModal) => void;
  nextTitles: Record<string, string>;
  generation: DemoSpacesModel["generation"];
  setGeneration: DemoSpacesModel["setGeneration"];
  agendaInput: string;
  setAgendaInput: (value: string) => void;
  updateRoom: RoomUpdater;
  setMeetingId: (id: string | null) => void;
  setIsEditingMinutes: (value: boolean) => void;
}) {
  const { room } = input;

  return (
    <>
      <header className={styles.pageHeader}>
        <div className={styles.headingRow}>
          <h1>{room.name}</h1>
          <button
            aria-label={settingsForRoomAriaLabel(room.name)}
            onClick={() => {
              input.go("Settings");
              input.setFeature("Board");
              input.setEditRoom(room.id);
            }}
          >
            <Icon name="Settings" />
          </button>
        </div>
        <p>{DEMO_SPACES_COPY.boardOfDirectors}</p>
        <div className={styles.members}>
          {room.members.map((name) => (
            <span key={name}>
              <Avatar name={name} />
              {name}
            </span>
          ))}
        </div>
      </header>
      <Section
        title={DEMO_SPACES_COPY.nextBoardMeetingSection}
        action={
          <button aria-label={DEMO_SPACES_COPY.changeNextMeetingAriaLabel} onClick={() => input.setModal("calendar")}>
            {DEMO_SPACES_COPY.changeMeetingButton}
          </button>
        }
      >
        <div className={styles.nextMeeting}>
          <span className={styles.dateTile}>
            <small>{DEMO_SPACES_COPY.nextMeetingMonthAbbrev}</small>
            {DEMO_SPACES_COPY.nextMeetingDay}
          </span>
          <div>
            <h3>{input.nextTitles[room.id] ?? DEMO_SPACES_COPY.defaultNextMeetingTitle}</h3>
            <p>{DEMO_SPACES_COPY.nextMeetingSchedule}</p>
            <small>
              {room.members.length} {DEMO_SPACES_COPY.boardMembersMeetingNote}
            </small>
          </div>
        </div>
        <div className={styles.generation}>
          <button
            className={styles.primary}
            disabled={input.generation !== null}
            onClick={() =>
              input.setGeneration({
                roomId: room.id,
                title: input.nextTitles[room.id] ?? DEMO_SPACES_COPY.defaultNextMeetingTitle,
                step: 0,
              })
            }
          >
            {input.generation !== null
              ? DEMO_SPACES_COPY.generationPreparingButton
              : DEMO_SPACES_COPY.generationPreviewButton}
          </button>
          <span role="status">
            {input.generation ? GENERATION_STATUS_MESSAGES[input.generation.step] : DEMO_SPACES_COPY.generationIdleHint}
          </span>
        </div>
      </Section>
      <DemoSpacesBoardRoomAgendaAndPast
        room={room}
        setModal={input.setModal}
        agendaInput={input.agendaInput}
        setAgendaInput={input.setAgendaInput}
        updateRoom={input.updateRoom}
        setMeetingId={input.setMeetingId}
        setIsEditingMinutes={input.setIsEditingMinutes}
      />
    </>
  );
}

function DemoSpacesBoardRoomAgendaAndPast(input: {
  room: DemoRoom;
  setModal: (value: DemoSpacesModal) => void;
  agendaInput: string;
  setAgendaInput: (value: string) => void;
  updateRoom: RoomUpdater;
  setMeetingId: (id: string | null) => void;
  setIsEditingMinutes: (value: boolean) => void;
}) {
  const { room } = input;

  return (
    <>
      <Section title={DEMO_SPACES_COPY.agendaSection}>
        {room.agenda.map((item, index) => (
          <div key={`${index}:${item}`} className={styles.agendaRow}>
            <span>{String(index + 1).padStart(AGENDA_INDEX_PAD_WIDTH, "0")}</span>
            {item}
          </div>
        ))}
        <form
          className={styles.addAgenda}
          onSubmit={(e) => {
            e.preventDefault();
            if (hasNonEmptyText(input.agendaInput.trim())) {
              input.updateRoom({
                id: room.id,
                change: (item) => ({
                  ...item,
                  agenda: [...item.agenda, input.agendaInput.trim()],
                }),
              });
            }
            input.setAgendaInput("");
          }}
        >
          <input
            aria-label={DEMO_SPACES_COPY.newAgendaItemAriaLabel}
            placeholder={DEMO_SPACES_COPY.addAgendaPlaceholder}
            value={input.agendaInput}
            onChange={(e) => input.setAgendaInput(e.target.value)}
          />
          <button disabled={!hasNonEmptyText(input.agendaInput.trim())}>{DEMO_SPACES_COPY.addAgendaButton}</button>
        </form>
      </Section>
      <Section title={DEMO_SPACES_COPY.materialsSection}>
        <button className={styles.document} onClick={() => input.setModal("document")}>
          <span>{DEMO_SPACES_COPY.documentTileIcon}</span>
          <span>
            {DEMO_SPACES_COPY.boardPackTitle}
            <small>{DEMO_SPACES_COPY.boardPackSummary}</small>
          </span>
          <span>{DEMO_SPACES_COPY.boardPackView}</span>
        </button>
      </Section>
      <Section title={DEMO_SPACES_COPY.pastBoardMeetingsSection}>
        {room.minutes.map((item) => (
          <button
            className={styles.meetingRow}
            key={item.id}
            onClick={() => {
              input.setMeetingId(item.id);
              input.setIsEditingMinutes(false);
            }}
          >
            <span>
              <strong>{item.title}</strong>
              <small>{item.date}</small>
            </span>
            <span className={styles.badge}>{item.status}</span>
            <span>{DEMO_SPACES_COPY.listChevron}</span>
          </button>
        ))}
      </Section>
    </>
  );
}

function DemoSpacesBoardMain({ model }: { model: DemoSpacesModel }) {
  const {
    room,
    meeting,
    setMeetingId,
    isEditingMinutes,
    setIsEditingMinutes,
    draft,
    setDraft,
    updateRoom,
    generation,
    setGeneration,
    agendaInput,
    setAgendaInput,
    setModal,
    nextTitles,
    go,
    setFeature,
    setEditRoom,
  } = model;

  return (
    <div className={styles.content}>
      <div className={styles.breadcrumb}>
        {DEMO_SPACES_COPY.breadcrumbBoard} <span>{DEMO_SPACES_COPY.breadcrumbSeparator}</span> {room.name}
        {meeting !== undefined ? (
          <>
            <span>{DEMO_SPACES_COPY.breadcrumbSeparator}</span> {DEMO_SPACES_COPY.breadcrumbMeetingMinutes}
          </>
        ) : null}
      </div>
      {meeting !== undefined ? (
        <DemoSpacesBoardMeetingDetail
          room={room}
          meeting={meeting}
          setMeetingId={setMeetingId}
          setIsEditingMinutes={setIsEditingMinutes}
          isEditingMinutes={isEditingMinutes}
          draft={draft}
          setDraft={setDraft}
          updateRoom={updateRoom}
        />
      ) : (
        <DemoSpacesBoardRoomOverview
          room={room}
          go={go}
          setFeature={setFeature}
          setEditRoom={setEditRoom}
          setModal={setModal}
          nextTitles={nextTitles}
          generation={generation}
          setGeneration={setGeneration}
          agendaInput={agendaInput}
          setAgendaInput={setAgendaInput}
          updateRoom={updateRoom}
          setMeetingId={setMeetingId}
          setIsEditingMinutes={setIsEditingMinutes}
        />
      )}
    </div>
  );
}

function DemoSpacesWorkspaceRail(input: { view: View; go: (next: View) => void }) {
  return (
    <aside className={styles.rail}>
      <a className={styles.brand} href="/" aria-label={DEMO_SPACES_COPY.readyHomeAriaLabel}>
        <ReadyLogo />
        <strong>{DEMO_SPACES_COPY.readyBrand}</strong>
      </a>
      <div className={styles.workspace}>
        <span className={styles.workspaceMark}>{DEMO_SPACES_COPY.workspaceMark}</span>
        <span>
          {DEMO_SPACES_COPY.readyWorkspaceTitle}
          <small>{DEMO_SPACES_COPY.demoWorkspaceSubtitle}</small>
        </span>
      </div>
      <nav aria-label="Demo navigation">
        <span className={styles.navLabel}>{DEMO_SPACES_COPY.workspaceNavLabel}</span>
        {WORKSPACE_NAV_VIEWS.map((item) => (
          <button
            key={item}
            className={input.view === item ? styles.active : ""}
            aria-current={input.view === item ? "page" : undefined}
            onClick={() => input.go(item)}
          >
            <Icon name={item} />
            {item}
          </button>
        ))}
      </nav>
      <div className={styles.railBottom}>
        <button className={input.view === "Settings" ? styles.active : ""} onClick={() => input.go("Settings")}>
          <Icon name="Settings" />
          {DEMO_SPACES_COPY.settingsNav}
        </button>
        <div className={styles.viewer}>
          <Avatar name={DEMO_SPACES_COPY.demoAccountName} />
          <span>
            {DEMO_SPACES_COPY.demoAccountName}
            <small>{DEMO_SPACES_COPY.demoAccountSubtitle}</small>
          </span>
        </div>
      </div>
    </aside>
  );
}

function DemoSpacesBoardRoomsListPanel(input: {
  rooms: DemoRoom[];
  roomId: string;
  setRoomId: (id: string) => void;
  setMeetingId: (id: string | null) => void;
  setIsEditingMinutes: (value: boolean) => void;
  go: (next: View) => void;
  setFeature: (feature: Feature) => void;
}) {
  return (
    <aside className={styles.list} aria-label="Board rooms">
      <div className={styles.listHeading}>
        <h2>{DEMO_SPACES_COPY.boardsHeading}</h2>
        <button
          aria-label={DEMO_SPACES_COPY.boardSettingsAriaLabel}
          onClick={() => {
            input.go("Settings");
            input.setFeature("Board");
          }}
        >
          <Icon name="Settings" />
        </button>
      </div>
      {input.rooms.map((item) => (
        <button
          className={joinModuleClasses(styles.roomButton, input.roomId === item.id ? styles.selected : undefined)}
          key={item.id}
          onClick={() => {
            input.setRoomId(item.id);
            input.setMeetingId(null);
            input.setIsEditingMinutes(false);
          }}
        >
          <strong>{item.name}</strong>
          <small>
            {item.country} {DEMO_SPACES_COPY.boardRoomCountrySuffix}
          </small>
        </button>
      ))}
      <p className={styles.listNote}>{DEMO_SPACES_COPY.boardRoomsNote}</p>
    </aside>
  );
}

function DemoSpacesSettingsFeaturesListPanel(input: {
  feature: Feature;
  setFeature: (feature: Feature) => void;
  setEditRoom: (id: string | null) => void;
}) {
  return (
    <aside className={styles.list} aria-label="Settings sections">
      <div className={styles.listHeading}>
        <h2>{DEMO_SPACES_COPY.settingsHeading}</h2>
      </div>
      <span className={styles.navLabel}>{DEMO_SPACES_COPY.featuresNavLabel}</span>
      {features.map((item) => (
        <button
          key={item}
          className={joinModuleClasses(styles.roomButton, input.feature === item ? styles.selected : undefined)}
          onClick={() => {
            input.setFeature(item);
            input.setEditRoom(null);
          }}
        >
          <strong>{item}</strong>
        </button>
      ))}
      <p className={styles.listNote}>{DEMO_SPACES_COPY.settingsListNote}</p>
    </aside>
  );
}

function DemoSpacesShellMainPanel({ model }: { model: DemoSpacesModel }) {
  const {
    view,
    rooms,
    feature,
    settingsRoom,
    requests,
    preview,
    updateRoom,
    setEditRoom,
    setModal,
    setNewName,
    setRoomId,
    go,
    setNotice,
    requestAccess,
    setSampleMeeting,
  } = model;

  return (
    <main className={styles.main}>
      {view === "Board" ? <DemoSpacesBoardMain model={model} /> : null}
      {view === "Settings" ? (
        <DemoSpacesSettingsMainView
          feature={feature}
          settingsRoom={settingsRoom}
          rooms={rooms}
          requests={requests}
          updateRoom={updateRoom}
          setEditRoom={setEditRoom}
          setModal={setModal}
          setNewName={setNewName}
          setRoomId={setRoomId}
          go={go}
          setNotice={setNotice}
          requestAccess={requestAccess}
        />
      ) : null}
      {view === "Upcoming" ? <DemoSpacesUpcomingView go={go} setModal={setModal} /> : null}
      {view === "Past meetings" ? (
        <DemoSpacesPastMeetingsView view={view} preview={preview} setSampleMeeting={setSampleMeeting} />
      ) : null}
      {view === "People" ? <DemoSpacesPeopleView rooms={rooms} /> : null}
      {view === "Tasks" ? <DemoSpacesTasksView rooms={rooms} updateRoom={updateRoom} /> : null}
    </main>
  );
}

function DemoSpacesLayout({ model }: { model: DemoSpacesModel }) {
  const {
    rooms,
    setRooms,
    roomId,
    setRoomId,
    view,
    setMeetingId,
    feature,
    setFeature,
    setEditRoom,
    setModal,
    newName,
    setNewName,
    notice,
    setIsEditingMinutes,
    setNextTitles,
    modalRef,
    modal,
    room,
    go,
    reset,
  } = model;

  return (
    <>
      <div className={styles.demo}>
        <header className={styles.banner}>
          <span>
            <strong>{DEMO_SPACES_COPY.readySpacesTitle}</strong>
            <span className={styles.demoTag}>{DEMO_SPACES_COPY.interactiveDemoTag}</span>
          </span>
          <span className={styles.bannerActions}>
            <span>{DEMO_SPACES_COPY.sampleDataHint}</span>
            <button onClick={reset}>{DEMO_SPACES_COPY.resetDemoButton}</button>
          </span>
        </header>
        <div className={styles.shell}>
          <DemoSpacesWorkspaceRail view={view} go={go} />
          {view === "Board" ? (
            <DemoSpacesBoardRoomsListPanel
              rooms={rooms}
              roomId={roomId}
              setRoomId={setRoomId}
              setMeetingId={setMeetingId}
              setIsEditingMinutes={setIsEditingMinutes}
              go={go}
              setFeature={setFeature}
            />
          ) : null}
          {view === "Settings" ? (
            <DemoSpacesSettingsFeaturesListPanel feature={feature} setFeature={setFeature} setEditRoom={setEditRoom} />
          ) : null}
          <DemoSpacesShellMainPanel model={model} />
        </div>
        {notice !== "" ? (
          <div role="status" className={styles.toast}>
            {notice}
          </div>
        ) : null}
      </div>
      <DemoSpacesDialog
        modalRef={modalRef}
        modal={modal}
        setModal={setModal}
        newName={newName}
        setNewName={setNewName}
        rooms={rooms}
        setRooms={setRooms}
        setEditRoom={setEditRoom}
        room={room}
        setNextTitles={setNextTitles}
      />
    </>
  );
}

export function DemoSpaces() {
  const model = useDemoSpacesModel();

  return <DemoSpacesLayout model={model} />;
}
