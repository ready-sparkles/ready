import { AdminDashboard } from "../../presentation/components/admin-dashboard";
import { RequireAuth } from "../../presentation/components/require-auth";

export default function AdminPage() {
  return (
    <RequireAuth>
      <AdminDashboard />
    </RequireAuth>
  );
}
