import type { Metadata } from "next";

import { WorkspaceDemoApp } from "../../../../presentation/components/workspace-demo/workspace-demo-app";

export const metadata: Metadata = {
  title: "Ready All memory preview",
  robots: { index: false, follow: false },
};

export default function MemoryPreview() {
  return <WorkspaceDemoApp initialScreen="memory" />;
}
