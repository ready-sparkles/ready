import { CreateWorkspacePage } from "../../../presentation/components/create-workspace-page";
import { RequireAuth } from "../../../presentation/components/require-auth";

export default function WorkspaceNewPage() {
  return (
    <RequireAuth>
      <CreateWorkspacePage />
    </RequireAuth>
  );
}
