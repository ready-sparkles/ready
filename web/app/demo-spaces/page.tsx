import type { Metadata } from "next";

import { DemoSpaces } from "../../presentation/components/demo-spaces/demo-spaces";

export const metadata: Metadata = {
  title: "Ready Spaces · Interactive demo",
  description: "Explore sample boardrooms, meeting minutes, and settings in a frontend-only Ready demo.",
  robots: { index: false, follow: false },
};
export default function DemoSpacesPage() {
  return <DemoSpaces />;
}
