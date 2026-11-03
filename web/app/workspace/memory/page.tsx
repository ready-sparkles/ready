import { RequireAuth } from "../../../presentation/components/require-auth";
import { WorkspaceMemoryPage } from "../../../presentation/components/workspace-memory";

export default function MemoryPage() {
  return (
    <RequireAuth>
      <WorkspaceMemoryPage />
    </RequireAuth>
  );
}
