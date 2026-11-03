import { useEffect, useRef } from "react";

const MEMORY_LOAD_MORE_DEFAULT_LABEL = "Load more";
const MEMORY_LOAD_MORE_RETRY_LABEL = "Try loading more again";

export function MemoryLoadMore({
  load,
  loading: isLoading,
  failed: hasFailed,
  label = MEMORY_LOAD_MORE_DEFAULT_LABEL,
  inert: isInert = false,
}: {
  load: () => void;
  /** @external existing React prop contract */
  loading: boolean;
  /** @external existing React prop contract */
  failed: boolean;
  label?: string;
  /** @external existing React prop contract */
  inert?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (isLoading || hasFailed || isInert || typeof IntersectionObserver === "undefined" || ref.current === null) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          load();
        }
      },
      { root: ref.current.closest(".relationship-memory-content"), rootMargin: "0px 0px 600px 0px" },
    );
    observer.observe(ref.current);

    return () => observer.disconnect();
  }, [load, isLoading, hasFailed, isInert]);

  return (
    <button ref={ref} className="relationship-memory-load-more" inert={isInert} disabled={isLoading} onClick={load}>
      {hasFailed ? MEMORY_LOAD_MORE_RETRY_LABEL : label}
    </button>
  );
}
