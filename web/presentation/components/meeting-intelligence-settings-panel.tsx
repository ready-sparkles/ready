"use client";

import { useEffect, useState } from "react";

import { getWorkspaceSettings, updateWorkspaceSettings } from "../../composition/api";

import { useAuth } from "./auth-provider";
import { SettingsDropdown } from "./settings-dropdown";

const COPY = {
  title: "Meeting intelligence",
  loadError: "Could not load meeting intelligence settings.",
  saveError: "Could not save meeting intelligence settings. Try again.",
  usage: "Live summary and ambient context use credits as they process the conversation.",
};
const DECISION_MODEL = { label: "Decision model", value: "jev-1.13.0", title: "TypeSafe Jev" };
const SUMMARY = {
  id: "live-summary",
  title: "Live summary",
  description: "Keep decisions, open questions, and tasks up to date as the conversation unfolds.",
  models: [DECISION_MODEL, { label: "Live summary model", value: "gpt-6-luna", title: "GPT-6 Luna" }],
};
const CONTEXT = {
  id: "ambient-context",
  title: "Ambient context",
  description: "Surface relevant information about people, companies, and topics during the conversation.",
  models: [
    DECISION_MODEL,
    { label: "Ambient context model", value: "gpt-5.4-nano", title: "GPT-5.4 Nano" },
    { label: "Ambient research model", value: "gpt-5.4-mini", title: "GPT-5.4 Mini" },
  ],
};

function DefaultModelDropdown({ model, isDisabled }: { model: (typeof SUMMARY.models)[number]; isDisabled: boolean }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="meeting-intelligence-model-row">
      <span>{model.label}</span>
      <SettingsDropdown
        value={model.value}
        options={[model]}
        isOpen={isDisabled ? false : isOpen}
        ariaLabel={model.label}
        isDisabled={isDisabled}
        onOpenChange={setIsOpen}
        onSelect={() => setIsOpen(false)}
      />
    </div>
  );
}

function IntelligenceFeature({
  feature,
  isEnabled,
  onChange,
  isDisabled,
}: {
  feature: typeof SUMMARY;
  isEnabled: boolean;
  onChange: (isEnabled: boolean) => void;
  isDisabled: boolean;
}) {
  return (
    <div className="relationship-memory-setting meeting-intelligence-feature">
      <div>
        <label htmlFor={feature.id}>{feature.title}</label>
        <p id={`${feature.id}-description`}>{feature.description}</p>
      </div>
      <input
        id={feature.id}
        type="checkbox"
        role="switch"
        aria-describedby={`${feature.id}-description`}
        disabled={isDisabled}
        checked={isEnabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {feature.models.map((model) => (
        <DefaultModelDropdown key={model.value} model={model} isDisabled={isDisabled || !isEnabled} />
      ))}
    </div>
  );
}

export function MeetingIntelligenceSettingsPanel() {
  const { session } = useAuth();
  if (session === null) {
    return null;
  }

  return (
    <PersistedIntelligenceSettings
      key={session.user.workspaceId}
      token={session.token}
      workspaceId={session.user.workspaceId}
    />
  );
}

function PersistedIntelligenceSettings({ token, workspaceId }: { token: string; workspaceId: string }) {
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof getWorkspaceSettings>> | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const loadState = { isCurrent: true };
    const load = async () => {
      try {
        const value = await getWorkspaceSettings({ token, workspaceId });
        if (loadState.isCurrent) {
          setSettings(value);
        }
      } catch (cause) {
        if (cause instanceof Error && loadState.isCurrent) {
          setError(COPY.loadError);
        }
      }
    };
    void load();

    return () => {
      loadState.isCurrent = false;
    };
  }, [token, workspaceId]);
  const canManage = settings?.viewerRole === "owner" || settings?.viewerRole === "admin";
  const save = async (input: { isLiveSummaryEnabled?: boolean; isAmbientContextEnabled?: boolean }) => {
    if (!canManage) {
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      setSettings(await updateWorkspaceSettings({ token, workspaceId, input }));
    } catch (cause) {
      if (cause instanceof Error) {
        setError(COPY.saveError);
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section aria-busy={settings === null || isSaving} className="settings-section relationship-memory-settings">
      <header className="settings-section-header">
        <h1>{COPY.title}</h1>
      </header>
      <IntelligenceFeature
        feature={SUMMARY}
        isEnabled={settings?.isLiveSummaryEnabled ?? true}
        isDisabled={!canManage || isSaving}
        onChange={(isLiveSummaryEnabled) => {
          void save({ isLiveSummaryEnabled });
        }}
      />
      <IntelligenceFeature
        feature={CONTEXT}
        isEnabled={settings?.isAmbientContextEnabled ?? true}
        isDisabled={!canManage || isSaving}
        onChange={(isAmbientContextEnabled) => {
          void save({ isAmbientContextEnabled });
        }}
      />
      {error !== null ? <p role="alert">{error}</p> : null}
      <p className="settings-note">{COPY.usage}</p>
    </section>
  );
}
