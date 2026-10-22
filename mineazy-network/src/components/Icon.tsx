/**
 * ============================================================================
 *  Icon.tsx — the console's line icons
 * ============================================================================
 *
 *  Inline SVG instead of an icon package: the console ships with no icon
 *  font, no remote sprite and no runtime dependency, which keeps the
 *  "works on a local island with no internet" promise honest.
 * ============================================================================
 */

"use client";

const PATHS: Record<string, string> = {
  overview: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  map: "M5 12h.01M19 6h.01M19 18h.01M7 11l10-4M7 13l10 4",
  devices: "M9 9h6v6H9zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3M4 4h16v16H4z",
  switches: "M3 5h18v5H3zM3 14h18v5H3zM7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6",
  incidents: "M12 3 2 20h20L12 3zM12 9v5M12 17h.01",
  traffic: "M3 12h4l3 8 4-16 3 8h4",
  discovery: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2M11 8a3 3 0 1 0 0 6",
  locations: "M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  events: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  reports: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5zM14 3v5h5M9 13h6M9 17h4",
  settings: "M4 6h6M14 6h6M4 12h10M18 12h2M4 18h3M11 18h9M12 4v4M16 10v4M9 16v4",
  signout: "M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h12",
  refresh: "M21 12a9 9 0 1 1-3-6.7M21 4v5h-5",
  download: "M12 3v12m0 0 4-4m-4 4-4-4M4 19h16",
  upload: "M12 21V9m0 0 4 4m-4-4-4 4M4 5h16",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6 6 18",
  chevron: "m9 6 6 6-6 6",
  external: "M14 4h6v6M20 4 10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  check: "M4 12l5 5L20 6",
  link: "M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1",
  play: "M6 4l14 8-14 8V4z",
  stop: "M6 6h12v12H6z",
  shield: "M12 3l8 3v6c0 5-3.4 8.3-8 9-4.6-.7-8-4-8-9V6l8-3z",
  key: "M14 8a5 5 0 1 0-4.6 7L4 20.4V21h3v-2h2v-2h2l1.4-1.4A5 5 0 0 0 14 8zM16.5 7.5h.01",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  filter: "M3 5h18l-7 8v6l-4 2v-8L3 5z",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
};

/** Icons that read better with a filled circle than a stroked one. */
const DOT_ICONS = new Set(["map"]);

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const d = PATHS[name] ?? PATHS.overview;
  if (DOT_ICONS.has(name)) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        <circle cx="5" cy="12" r="2.4" fill="currentColor" />
        <circle cx="19" cy="6" r="2.4" fill="currentColor" />
        <circle cx="19" cy="18" r="2.4" fill="currentColor" />
        <path d={d} />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
