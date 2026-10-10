/** Minimal inline icon set — stroke-based so it inherits currentColor. */

type P = { className?: string };

const base = "h-4 w-4";

export const IconUsers = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19" />
    <circle cx="10" cy="8" r="3.2" />
    <path d="M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4" />
    <path d="M15.5 5.2a3.2 3.2 0 0 1 0 5.6" />
  </svg>
);

export const IconScan = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className={className} aria-hidden="true">
    <path d="M12 4.5a7.5 7.5 0 0 0-7.5 7.5c0 1-.1 2-.3 3" />
    <path d="M12 7.6a4.4 4.4 0 0 0-4.4 4.4c0 1.9.2 3.4.7 4.9" />
    <path d="M12 10.7a1.3 1.3 0 0 0-1.3 1.3c0 2.5.5 4.6 1.3 6.3" />
    <path d="M15.3 12A3.3 3.3 0 0 0 12 8.7" />
    <path d="M19.5 12A7.5 7.5 0 0 0 15.8 5.1" />
  </svg>
);

export const IconServer = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className} aria-hidden="true">
    <rect x="3.5" y="4.5" width="17" height="6" rx="2" />
    <rect x="3.5" y="13.5" width="17" height="6" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </svg>
);

export const IconSync = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M20 11.5A8 8 0 0 0 6.3 6.3L4 8.5" />
    <path d="M4 4.5v4h4" />
    <path d="M4 12.5a8 8 0 0 0 13.7 5.2L20 15.5" />
    <path d="M20 19.5v-4h-4" />
  </svg>
);

export const IconArrow = ({ direction, className = "h-3.5 w-3.5" }: P & { direction: "IN" | "OUT" }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    {direction === "IN" ? (
      <>
        <path d="M14 5h5v5" />
        <path d="M19 5l-7.5 7.5" />
        <path d="M19 14.5V19H5V5h4.5" />
      </>
    ) : (
      <>
        <path d="M10 5H5v5" />
        <path d="M5 5l7.5 7.5" />
        <path d="M5 14.5V19h14V5h-4.5" />
      </>
    )}
  </svg>
);

export const IconClock = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 1.8" />
  </svg>
);

export const IconAlert = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M12 4.5 21 19.5H3L12 4.5Z" />
    <path d="M12 10v4" />
    <path d="M12 17h.01" />
  </svg>
);

export const IconHome = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19v-8.5Z" />
    <path d="M9.5 20.5v-6h5v6" />
  </svg>
);

export const IconBriefcase = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <rect x="3.5" y="7.5" width="17" height="12" rx="2" />
    <path d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5" />
    <path d="M3.5 12.5h17" />
  </svg>
);

export const IconChart = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M4 19.5h16" />
    <path d="M7.5 16.5v-5" />
    <path d="M12 16.5v-9" />
    <path d="M16.5 16.5v-6.5" />
  </svg>
);

export const IconCalendar = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <rect x="3.5" y="5.5" width="17" height="15" rx="2" />
    <path d="M3.5 10h17M8 3.5v4M16 3.5v4" />
  </svg>
);

export const IconEye = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const IconMenu = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className} aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

export const IconFilter = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M4 5.5h16l-6.2 7.4v5.4l-3.6-2v-3.4L4 5.5Z" />
  </svg>
);

export const IconSearch = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className} aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20.5 20.5-4-4" />
  </svg>
);

export const IconCheck = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

export const IconX = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

/** Pencil mark — inline row edit action (Phase 11). */
export const IconEdit = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M4.5 19.5h15" />
    <path d="M6 15.9 15.9 6a1.9 1.9 0 0 1 2.7 0l.4.4a1.9 1.9 0 0 1 0 2.7L9.1 19H6v-3.1Z" />
  </svg>
);

/** Bin mark — inline row delete action (Phase 11). */
export const IconTrash = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M4.5 6.5h15M9.5 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" />
    <path d="M6.5 6.5 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12.5" />
    <path d="M10.5 10v6M13.5 10v6" />
  </svg>
);

/** Gear mark — Settings (Phase 11). */
export const IconSettings = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="3.1" />
    <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" />
  </svg>
);

/** Calendar-with-clock mark — Shifts & schedules (Phase 11). */
export const IconSchedule = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M20 10.5V7a1.5 1.5 0 0 0-1.5-1.5h-13A1.5 1.5 0 0 0 4 7v11a1.5 1.5 0 0 0 1.5 1.5H11" />
    <path d="M4 10h16M8 3.5v3M15 3.5v3" />
    <circle cx="17" cy="16.5" r="4" />
    <path d="M17 14.8v1.8l1.2.8" />
  </svg>
);

/** Concentric-arc fingerprint mark used as the BIOBRIDGE brand glyph. */
export const IconFingerprint = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className={className} aria-hidden="true">
    <path d="M12 4.2a7.8 7.8 0 0 0-7.8 7.8c0 1.1-.1 2.2-.3 3.2" />
    <path d="M12 7.4a4.6 4.6 0 0 0-4.6 4.6c0 1.9.2 3.4.7 5" />
    <path d="M12 10.6a1.4 1.4 0 0 0-1.4 1.4c0 2.6.5 4.7 1.3 6.4" />
    <path d="M15.4 12A3.4 3.4 0 0 0 12 8.6" />
    <path d="M19.8 12A7.8 7.8 0 0 0 16 5" />
    <path d="M15.8 15.6c.4 1.5.6 3 .6 4.6" />
    <path d="M20.4 15.4c.3 1.1.4 2.2.4 3.4" />
  </svg>
);

/** Printer mark — print / save-as-PDF report action. */
export const IconPrint = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M7 8V4.8a1.3 1.3 0 0 1 1.3-1.3h7.4A1.3 1.3 0 0 1 17 4.8V8" />
    <rect x="4.5" y="8" width="15" height="8" rx="1.5" />
    <path d="M7 14h10v6H7z" />
    <path d="M17.5 11.5h.01" />
  </svg>
);

/** Download mark — export to file. */
export const IconDownload = ({ className = base }: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M12 3.5v11" />
    <path d="m7.5 10 4.5 4.5L16.5 10" />
    <path d="M4.5 19.5h15" />
  </svg>
);
