import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";
import { useState } from "react";

import { SettingsDropdown } from "../../../presentation/components/settings-dropdown";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = [
  { value: "light", title: "Light" },
  { value: "dark", title: "Dark" },
] as const;

function ThemeDropdown() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [isOpen, setIsOpen] = useState(false);

  return (
    <SettingsDropdown
      value={theme}
      options={OPTIONS}
      isOpen={isOpen}
      ariaLabel="Theme"
      onOpenChange={setIsOpen}
      onSelect={setTheme}
    />
  );
}

void test("selects an option and closes the settings dropdown", () => {
  const view = render(<ThemeDropdown />);
  const trigger = view.getByRole("button", { name: "Theme: Light" });

  fireEvent.click(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  view.getByRole("listbox", { name: "Theme" });

  fireEvent.click(view.getByRole("option", { name: "Dark" }));

  assert.equal(view.getByRole("button", { name: "Theme: Dark" }).getAttribute("aria-expanded"), "false");
  assert.equal(view.queryByRole("listbox", { name: "Theme" }), null);
  view.unmount();
});

void test("closes the settings dropdown with Escape", () => {
  const view = render(<ThemeDropdown />);
  const trigger = view.getByRole("button", { name: "Theme: Light" });

  fireEvent.click(trigger);
  fireEvent.keyDown(window, { key: "Escape" });

  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(view.queryByRole("listbox", { name: "Theme" }), null);
  view.unmount();
});
