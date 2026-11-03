import { MetalFx, PRESETS, type PresetTheme, setSharedPreset } from "metal-fx";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useTheme } from "./theme-provider";

const webGlSupport: { isSupported: boolean | null } = { isSupported: null };

/** metal-fx throws during render without WebGL; fall back to the plain trigger instead. */
function readWebGlSupport(): boolean {
  const canvas = document.createElement("canvas");
  webGlSupport.isSupported ??= (canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl")) !== null;

  return webGlSupport.isSupported;
}

const subscribeToWebGlSupport = () => () => undefined;
const readServerWebGlSupport = () => false;

/** Server and hydration render the plain trigger; the client switches to MetalFx after hydration. */
function useCanRenderMetalFx(): boolean {
  return useSyncExternalStore(subscribeToWebGlSupport, readWebGlSupport, readServerWebGlSupport);
}

const SILVER_PRESET_SPEED = 0.9;
const SELECTION_CUE_SIZE_PX = 36;
const EXTRA_ACTIONS_MENU_SEPARATOR_INDEX = 2;

type TaskSelectionExtraAction = {
  label: string;
  /** @external TaskSelectionMenu extra action field */
  disabled: boolean;
  onSelect: () => void;
};

type TaskSelectionMenuAction = {
  label: string;
  /** @external TaskSelectionMenu action disabled state */
  disabled: boolean;
  onSelect: () => void;
};

// Match Highlight's working selection cue exactly: Silver's liquid-metal
// field is tinted around the ruler blue, with alternating deep and pale tones
// preserving visible motion at a lower strength.
Object.assign(PRESETS.silver.modes.dark, {
  colors: ["#0c1522", "#7297cf", "#365886", "#aec6e7", "#14253b", "#d4e1f2", "#93b2de"],
  speed: SILVER_PRESET_SPEED,
});

// On light surfaces, use a neutral silver field instead of the dark mode's
// ruler-blue tint. The alternating whites and cool grays keep the liquid
// movement legible without becoming chromatic or high contrast.
Object.assign(PRESETS.silver.modes.light, {
  colors: ["#f5f6f7", "#ffffff", "#dfe2e5", "#fafafa", "#aeb3b9", "#d2d6da", "#f1f2f3"],
  speed: SILVER_PRESET_SPEED,
});

function buildTaskSelectionActions(input: {
  hasSelection: boolean;
  completeLabel: string;
  canComplete: boolean;
  onComplete: () => void;
  removeLabel: string;
  canRemove: boolean;
  onRemove: () => void;
  extraActions: TaskSelectionExtraAction[];
}): TaskSelectionMenuAction[] {
  const selectionActions: TaskSelectionMenuAction[] = input.hasSelection
    ? [
        {
          label: input.completeLabel,
          disabled: !input.canComplete,
          onSelect: input.onComplete,
        },
        {
          label: input.removeLabel,
          disabled: !input.canRemove,
          onSelect: input.onRemove,
        },
      ]
    : [];

  return [...selectionActions, ...input.extraActions];
}

function useShouldReduceMotion() {
  const [shouldReduceMotion, setShouldReduceMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setShouldReduceMotion(query.matches);
    update();
    query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  }, []);

  return shouldReduceMotion;
}

function useTaskSelectionMetalFxPreset(input: { hasSelection: boolean; theme: PresetTheme }) {
  useEffect(() => {
    if (!input.hasSelection || !readWebGlSupport()) {
      return;
    }
    // Upload the custom palette after Fast Refresh as well as initial mount;
    // MetalFx otherwise only uploads when the preset name changes.
    setSharedPreset("silver", input.theme);
  }, [input.hasSelection, input.theme]);
}

function useTaskSelectionMenuDismissal(input: {
  isOpen: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!input.isOpen) {
      return;
    }
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (event.target instanceof Node && !(input.rootRef.current?.contains(event.target) ?? false)) {
        input.onClose();
      }
    };
    const closeOnFocusOutside = (event: FocusEvent) => {
      if (event.target instanceof Node && !(input.rootRef.current?.contains(event.target) ?? false)) {
        input.onClose();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePress, true);
    document.addEventListener("focusin", closeOnFocusOutside, true);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress, true);
      document.removeEventListener("focusin", closeOnFocusOutside, true);
    };
  }, [input.isOpen, input.onClose, input.rootRef]);
}

function focusFirstEnabledMenuItem(itemRefs: RefObject<(HTMLButtonElement | null)[]>) {
  itemRefs.current.find((item) => (item && !item.disabled) === true)?.focus();
}

function handleTaskSelectionMenuKeyDown(input: {
  event: KeyboardEvent<HTMLDivElement>;
  isOpen: boolean;
  setIsOpen: (update: (isCurrentlyOpen: boolean) => boolean) => void;
  itemRefs: RefObject<(HTMLButtonElement | null)[]>;
  onClose: (shouldRestoreFocus: boolean) => void;
}) {
  input.event.stopPropagation();
  if (input.event.key === "Escape") {
    input.event.preventDefault();
    input.onClose(true);

    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(input.event.key)) {
    return;
  }
  input.event.preventDefault();
  if (!input.isOpen) {
    input.setIsOpen(() => true);

    return;
  }
  const enabled = input.itemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item && !item.disabled));
  if (enabled.length === 0) {
    return;
  }
  const index = enabled.findIndex((item) => item === document.activeElement);
  const next =
    input.event.key === "Home"
      ? 0
      : input.event.key === "End"
        ? enabled.length - 1
        : (index + (input.event.key === "ArrowUp" ? enabled.length - 1 : 1)) % enabled.length;
  enabled[next]?.focus();
}

function TaskSelectionMenuTrigger({
  triggerRef,
  hasSelection,
  label,
  isOpen,
  busy: isBusy,
  onToggle,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  hasSelection: boolean;
  label: string;
  isOpen: boolean;
  /** @external TaskSelectionMenu consumer prop */
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      ref={triggerRef}
      type="button"
      className={hasSelection ? "workspace-task-selection-trigger" : "workspace-task-topbar-button"}
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={isOpen}
      disabled={isBusy}
      onClick={onToggle}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" width="18" height="18" fill="currentColor">
        <circle cx="3" cy="8" r="1.15" />
        <circle cx="8" cy="8" r="1.15" />
        <circle cx="13" cy="8" r="1.15" />
      </svg>
    </button>
  );
}

function TaskSelectionMenuOptions({
  label,
  hasSelection,
  actions,
  busy: isBusy,
  registerMenuItemRef,
  onClose,
}: {
  label: string;
  hasSelection: boolean;
  actions: TaskSelectionMenuAction[];
  /** @external TaskSelectionMenu consumer prop */
  busy: boolean;
  registerMenuItemRef: (input: { index: number; node: HTMLButtonElement | null }) => void;
  onClose: (shouldRestoreFocus: boolean) => void;
}) {
  return (
    <div className="workspace-task-selection-options" role="menu" aria-label={label}>
      {actions.map((action, index) => (
        <Fragment key={action.label}>
          {hasSelection && index === EXTRA_ACTIONS_MENU_SEPARATOR_INDEX ? (
            <div className="workspace-task-menu-separator" role="separator" />
          ) : null}
          <button
            ref={(node) => registerMenuItemRef({ index, node })}
            type="button"
            role="menuitem"
            disabled={isBusy || action.disabled}
            onClick={() => {
              onClose(true);
              action.onSelect();
            }}
          >
            {action.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

function TaskSelectionMenuSurface(input: {
  rootRef: RefObject<HTMLDivElement | null>;
  className: string;
  isOpen: boolean;
  setIsOpen: (update: (isCurrentlyOpen: boolean) => boolean) => void;
  itemRefs: RefObject<(HTMLButtonElement | null)[]>;
  onClose: (shouldRestoreFocus: boolean) => void;
  hasSelection: boolean;
  theme: PresetTheme;
  shouldReduceMotion: boolean;
  trigger: ReactNode;
  menuLabel: string;
  actions: TaskSelectionMenuAction[];
  isBusy: boolean;
  registerMenuItemRef: (input: { index: number; node: HTMLButtonElement | null }) => void;
}) {
  const canRenderMetalFx = useCanRenderMetalFx();

  return (
    <div
      ref={input.rootRef}
      className={`workspace-task-selection-menu ${input.className}`.trim()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) =>
        handleTaskSelectionMenuKeyDown({
          event,
          isOpen: input.isOpen,
          setIsOpen: input.setIsOpen,
          itemRefs: input.itemRefs,
          onClose: input.onClose,
        })
      }
    >
      {input.hasSelection && canRenderMetalFx ? (
        <MetalFx
          className="workspace-task-selection-cue is-active"
          style={{
            width: SELECTION_CUE_SIZE_PX,
            height: SELECTION_CUE_SIZE_PX,
            flexBasis: SELECTION_CUE_SIZE_PX,
          }}
          preset="silver"
          strength={0.62}
          theme={input.theme}
          variant="circle"
          paused={input.shouldReduceMotion}
          borderRadius={18}
          ringCssPx={1.5}
          shaderScale={1.3}
          normalizeHostStyles={false}
        >
          {input.trigger}
        </MetalFx>
      ) : (
        input.trigger
      )}
      {input.isOpen ? (
        <TaskSelectionMenuOptions
          label={input.menuLabel}
          hasSelection={input.hasSelection}
          actions={input.actions}
          busy={input.isBusy}
          registerMenuItemRef={input.registerMenuItemRef}
          onClose={input.onClose}
        />
      ) : null}
    </div>
  );
}

export function TaskSelectionMenu({
  canComplete,
  canRemove,
  onComplete,
  onRemove,
  completeLabel = "Mark as completed",
  removeLabel = "Remove",
  hasSelection = true,
  extraActions = [],
  busy: isBusy = false,
  label = "Selected task options",
  className = "",
}: {
  canComplete: boolean;
  canRemove: boolean;
  onComplete: () => void;
  onRemove: () => void;
  completeLabel?: string;
  removeLabel?: string;
  hasSelection?: boolean;
  extraActions?: TaskSelectionExtraAction[];
  /** @external TaskSelectionMenu consumer prop */
  busy?: boolean;
  label?: string;
  className?: string;
}) {
  const { theme } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const shouldReduceMotion = useShouldReduceMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const actions = buildTaskSelectionActions({
    hasSelection,
    completeLabel,
    canComplete,
    onComplete,
    removeLabel,
    canRemove,
    onRemove,
    extraActions,
  });

  function close(shouldRestoreFocus = false) {
    setIsOpen(false);
    if (shouldRestoreFocus) {
      triggerRef.current?.focus();
    }
  }

  useTaskSelectionMetalFxPreset({ hasSelection, theme });
  useTaskSelectionMenuDismissal({ isOpen, rootRef, onClose: () => close() });

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    focusFirstEnabledMenuItem(itemRefs);
  }, [isOpen]);

  const registerMenuItemRef = (input: { index: number; node: HTMLButtonElement | null }) => {
    // Assign by index: mapping over the (initially empty) array never registered items.
    itemRefs.current = Array.from({ length: Math.max(itemRefs.current.length, input.index + 1) }, (_, itemIndex) =>
      itemIndex === input.index ? input.node : (itemRefs.current[itemIndex] ?? null),
    );
  };

  const trigger = (
    <TaskSelectionMenuTrigger
      triggerRef={triggerRef}
      hasSelection={hasSelection}
      label={label}
      isOpen={isOpen}
      busy={isBusy}
      onToggle={() => setIsOpen((isCurrentlyOpen) => !isCurrentlyOpen)}
    />
  );

  return (
    <TaskSelectionMenuSurface
      rootRef={rootRef}
      className={className}
      isOpen={isOpen}
      setIsOpen={setIsOpen}
      itemRefs={itemRefs}
      onClose={close}
      hasSelection={hasSelection}
      theme={theme}
      shouldReduceMotion={shouldReduceMotion}
      trigger={trigger}
      menuLabel={label}
      actions={actions}
      isBusy={isBusy}
      registerMenuItemRef={registerMenuItemRef}
    />
  );
}
