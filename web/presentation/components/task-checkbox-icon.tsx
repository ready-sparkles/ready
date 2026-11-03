export function TaskCheckboxIcon(
  props: Readonly<{
    /** @external checkbox control checked state */
    checked: boolean;
  }>,
) {
  const isChecked = props.checked;
  if (isChecked) {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="workspace-task-checkbox-svg" fill="none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12" cy="12" r="5.75" fill="currentColor" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="workspace-task-checkbox-svg" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
