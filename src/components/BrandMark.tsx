/**
 * BioBridge brand mark — the Bridge B monogram.
 *
 * A single pier carries two bridge arches, drawing a "B" that doubles as a
 * span. Drawn in `currentColor` so it inherits the surrounding tile/theme,
 * and kept deliberately chunky so it survives a 24 px render in the sidebar.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      className={className}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="148" y="112" width="52" height="288" rx="26" fill="currentColor" />
      <path
        d="M200 138 H 292 A 74 74 0 0 1 292 286 H 200"
        stroke="currentColor"
        strokeWidth={52}
        strokeLinecap="round"
      />
      <path
        d="M200 286 H 306 A 78 78 0 0 1 306 442 H 200"
        stroke="currentColor"
        strokeWidth={52}
        strokeLinecap="round"
      />
    </svg>
  );
}
