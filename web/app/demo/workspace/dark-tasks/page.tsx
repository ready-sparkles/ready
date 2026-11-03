import type { Metadata } from "next";

import { WorkspaceDemoApp } from "../../../../presentation/components/workspace-demo/workspace-demo-app";

export const metadata: Metadata = { title: "Ready tasks preview", robots: { index: false, follow: false } };
export default function TasksPreview() {
  return <WorkspaceDemoApp initialScreen="tasks" />;
}
