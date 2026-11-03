import { useEffect } from "react";

/** Calls onDismiss when a pointer goes down outside every element matching insideSelector. */
export function useOutsidePointerDismiss(input: {
  isActive: boolean;
  insideSelector: string;
  onDismiss: () => void;
}): void {
  const { isActive, insideSelector, onDismiss } = input;
  useEffect(() => {
    if (!isActive) {
      return undefined;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(insideSelector) !== null) {
        return;
      }
      onDismiss();
    };
    document.addEventListener("pointerdown", handlePointerDown);

    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isActive, insideSelector, onDismiss]);
}
