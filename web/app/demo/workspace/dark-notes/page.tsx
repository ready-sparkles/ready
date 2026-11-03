import type { Metadata } from "next";

import { WorkspaceDemoApp } from "../../../../presentation/components/workspace-demo/workspace-demo-app";

export const metadata: Metadata = {
  title: "Ready meeting notes in dark mode",
  robots: { index: false, follow: false },
};

export default function DarkNotesPreview() {
  return <WorkspaceDemoApp initialScreen="notes" />;
}
