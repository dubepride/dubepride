import { initials } from "@/lib/format";

interface AvatarProps {
  name: string;
  /**
   * `neon`   — active/engaged employee (green ring, on-brand glow)
   * `muted`  — absent / clocked-out employee (dimmed ring)
   */
  tone?: "neon" | "muted";
  className?: string;
}

/**
 * Circular initials placeholder used across the dashboard widget list
 * (Employee Status, Approaching Overtime, Time Off Requests). Purely
 * presentational — deterministic from `name`, so server and client
 * render identical markup.
 */
export default function Avatar({ name, tone = "neon", className = "" }: AvatarProps) {
  const skin =
    tone === "neon"
      ? "border-neon/50 bg-panel-deep text-neon shadow-[0_0_10px_rgba(0,230,118,0.15)]"
      : "border-muted/40 bg-panel-deep/70 text-muted";

  return (
    <span
      className={`grid h-9 w-9 flex-none place-items-center rounded-full border text-[11px] font-bold tracking-wide ${skin} ${className}`}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
