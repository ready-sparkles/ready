import type { Metadata } from "next";

import { WorkspaceDemoApp } from "../../../presentation/components/workspace-demo/workspace-demo-app";

export const metadata: Metadata = {
  title: "Ready workspace demo",
  robots: { index: false, follow: false },
};

// Embedded by the public homepage. Everything here runs on illustrative local
// data; see lib/workspace-demo.
export default function WorkspaceDemoPage() {
  return <WorkspaceDemoApp />;
}
