"use client";

import { type CSSProperties, type ElementType, type ReactNode, useEffect, useRef, useState } from "react";

/** Fades content up into place the first time it scrolls into view, like
 * Apple's product pages. Reduced motion shows it immediately (see CSS). */
export function ScrollReveal({
  as: Tag = "div",
  className = "",
  delayMs = 0,
  children,
  ...rest
}: {
  as?: ElementType;
  className?: string;
  delayMs?: number;
  children: ReactNode;
} & Record<string, unknown>) {
  const ref = useRef<HTMLElement | null>(null);
  const [isRevealed, setIsRevealed] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setIsRevealed(true);

      return;
    }
    // Reveal once a slice of the element is on screen, not the moment its
    // top edge peeks in, so the motion is actually seen.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsRevealed(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      ref={ref}
      className={`scroll-reveal${isRevealed ? " is-revealed" : ""}${className.length !== 0 ? ` ${className}` : ""}`}
      style={delayMs !== 0 ? ({ "--scroll-reveal-delay": `${delayMs}ms` } satisfies CSSProperties) : undefined}
      {...rest}
    >
      {children}
    </Tag>
  );
}
