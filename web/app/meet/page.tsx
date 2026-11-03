import { Suspense } from "react";

import { InstantEntry } from "../../presentation/components/instant-entry";

export default function MeetPage() {
  return (
    <Suspense fallback={null}>
      <InstantEntry />
    </Suspense>
  );
}
