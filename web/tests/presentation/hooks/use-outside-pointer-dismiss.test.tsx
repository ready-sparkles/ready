import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import { useOutsidePointerDismiss } from "../../../presentation/hooks/use-outside-pointer-dismiss";

GlobalRegistrator.register();

const INSIDE_LABEL = "inside";
const OUTSIDE_LABEL = "outside";

function Harness({ isActive, onDismiss }: { isActive: boolean; onDismiss: () => void }) {
  useOutsidePointerDismiss({ isActive, insideSelector: "[data-inside]", onDismiss });

  return (
    <div>
      <aside data-inside="">
        <span>{INSIDE_LABEL}</span>
      </aside>
      <button type="button">{OUTSIDE_LABEL}</button>
    </div>
  );
}

void test("dismisses on outside pointerdown only while active", () => {
  const dismissals = { count: 0 };
  const recordDismiss = () => {
    dismissals.count += 1;
  };
  const view = render(<Harness isActive onDismiss={recordDismiss} />);
  fireEvent.pointerDown(view.getByText(INSIDE_LABEL));
  assert.equal(dismissals.count, 0);
  fireEvent.pointerDown(view.getByText(OUTSIDE_LABEL));
  assert.equal(dismissals.count, 1);
  view.rerender(<Harness isActive={false} onDismiss={recordDismiss} />);
  fireEvent.pointerDown(view.getByText(OUTSIDE_LABEL));
  assert.equal(dismissals.count, 1);
  view.unmount();
});
