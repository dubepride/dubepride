/**
 * BioBridge brand mark — a geofence pin whose heart is an arch bridge.
 * Drawn in `currentColor` so it inherits the surrounding tile/theme, and
 * kept deliberately chunky so it survives a 24 px render in the sidebar.
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
      <path
        d="M256 92 C181 92 120 153 120 228 C120 312 256 440 256 440 C256 440 392 312 392 228 C392 153 331 92 256 92 Z"
        stroke="currentColor"
        strokeWidth={30}
        strokeLinejoin="round"
      />
      <path
        d="M190 262 A 66 66 0 0 1 322 262"
        stroke="currentColor"
        strokeWidth={28}
        strokeLinecap="round"
      />
      <rect x="164" y="256" width="184" height="26" rx="13" fill="currentColor" />
      <rect x="172" y="270" width="26" height="56" rx="13" fill="currentColor" />
      <rect x="314" y="270" width="26" height="56" rx="13" fill="currentColor" />
    </svg>
  );
}
