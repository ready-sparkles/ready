import { RequireAuth } from "../../presentation/components/require-auth";
import { WorkspaceHome } from "../../presentation/components/workspace-home";

export default async function WorkspacePage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  const normalizedView = view === "upcoming" ? "upcoming" : "past";

  return (
    <RequireAuth>
      <WorkspaceHome view={normalizedView} />
    </RequireAuth>
  );
}
