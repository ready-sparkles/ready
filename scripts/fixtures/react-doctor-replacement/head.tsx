import { useState } from "react";

export function Example({ enabled }: { enabled: boolean }) {
  const [oldValue] = useState("fixed violation");
  if (!enabled) return null;

  const [replacementValue] = useState("replacement violation");
  return (
    <div>
      {oldValue}
      {replacementValue}
    </div>
  );
}
