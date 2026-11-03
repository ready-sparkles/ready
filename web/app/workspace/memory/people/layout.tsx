import { RequireAuth } from "../../../../presentation/components/require-auth";
import { WorkspaceMemoryPeoplePage } from "../../../../presentation/components/workspace-memory";

export default function PeopleLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <WorkspaceMemoryPeoplePage />
      {children}
    </RequireAuth>
  );
}
