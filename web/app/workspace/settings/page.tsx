import { RequireAuth } from "../../../presentation/components/require-auth";
import { WorkspaceSettingsPage as WorkspaceSettingsScreen } from "../../../presentation/components/workspace-settings-page";

export default function WorkspaceSettingsPage() {
  return (
    <RequireAuth>
      <WorkspaceSettingsScreen />
    </RequireAuth>
  );
}
