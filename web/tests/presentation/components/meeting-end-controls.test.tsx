import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import { MeetingEndControls } from "../../../presentation/components/meeting-end-controls";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ORGANIZER_CASES = [false, true] as const;

ORGANIZER_CASES.forEach((isOrganizer) => {
  void test(`end controls use the correct action (organizer: ${isOrganizer})`, () => {
    const actionLog: { entries: string[] } = { entries: [] };
    const props = {
      isOrganizer,
      isOpen: false,
      isLeaving: false,
      onToggleMenu: () => {
        actionLog.entries = [...actionLog.entries, "menu"];
      },
      onLeave: () => {
        actionLog.entries = [...actionLog.entries, "leave"];
      },
      onEndForAll: () => {
        actionLog.entries = [...actionLog.entries, "end"];
      },
      children: "phone",
    };
    const screen = render(<MeetingEndControls {...props} />);
    try {
      fireEvent.click(screen.getByRole("button"));
      assert.deepEqual(actionLog.entries, [isOrganizer ? "menu" : "leave"]);
      screen.rerender(<MeetingEndControls {...props} isOpen />);
      if (isOrganizer) {
        fireEvent.click(screen.getByRole("menuitem", { name: "Leave meeting" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "End meeting for all" }));
        assert.deepEqual(actionLog.entries, ["menu", "leave", "end"]);
      } else {
        assert.equal(screen.queryByRole("menu"), null);
        assert.equal(screen.getByRole("button").getAttribute("aria-label"), "Leave meeting");
      }
      const previous = [...actionLog.entries];
      screen.rerender(<MeetingEndControls {...props} isOpen isLeaving />);
      fireEvent.click(screen.getByRole("button"));
      screen.queryAllByRole("menuitem").forEach((item) => {
        fireEvent.click(item);
      });
      assert.deepEqual(actionLog.entries, previous, "duplicate clicks are disabled during departure");
      screen.rerender(<MeetingEndControls {...props} isJoining />);
      fireEvent.click(screen.getByRole("button"));
      assert.deepEqual(actionLog.entries, previous, "initial connection cannot race with departure");
    } finally {
      cleanup();
    }
  });
});
