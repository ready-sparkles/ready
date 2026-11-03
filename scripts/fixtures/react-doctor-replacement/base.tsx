import { useState } from "react";

export function Example({ enabled }: { enabled: boolean }) {
  if (enabled) {
    const [oldValue] = useState("old violation");
    return <div>{oldValue}</div>;
  }
  return null;
}
