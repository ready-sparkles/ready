// Highlight’s new-card surface and edge sweep, with its original SVG distortion.
export function MemoryCardOrganicShimmer({ isRevealed }: { isRevealed: boolean }) {
  return (
    <div className={`memory-card-organic-shimmer${isRevealed ? " is-revealed" : ""}`} aria-hidden="true">
      <span className="memory-card-organic-shimmer-wave">
        <span className="memory-card-organic-shimmer-band" />
      </span>
      <span className="memory-card-organic-shimmer-edge">
        <span className="memory-card-organic-shimmer-edge-bloom" />
        <span className="memory-card-organic-shimmer-edge-glow" />
        <span className="memory-card-organic-shimmer-edge-ring" />
      </span>
    </div>
  );
}

export function MemoryCardOrganicShimmerFilter() {
  return (
    <svg className="memory-card-organic-shimmer-filter" width="0" height="0" aria-hidden="true" focusable="false">
      <filter id="memory-card-organic-shimmer-warp" x="-40%" y="-40%" width="180%" height="180%">
        <feTurbulence type="fractalNoise" baseFrequency="0.009 0.015" numOctaves="2" seed="7" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="46" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
