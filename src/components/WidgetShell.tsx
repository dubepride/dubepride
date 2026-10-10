import type { ReactNode } from "react";

interface WidgetShellProps {
  /** Card heading — rendered in the top bar of the card. */
  title: string;
  /** Optional anchor id (sidebar shortcuts scroll to it). */
  id?: string;
  /** Right-hand slot in the card header (chips, counts). */
  meta?: ReactNode;
  /** Body padding — defaults to the standard p-5 rhythm. */
  bodyClassName?: string;
  /** Optional footer strip (counts, notes) below the body. */
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * Shared shell for the redesigned dashboard widgets (Employee Status,
 * Exceptions, Approaching Overtime, Time Off Requests): deep-purple glass
 * card + neon accent line + uppercase header, matching the BIOBRIDGE
 * design tokens. `scroll-mt-24` keeps anchor jumps clear of the sticky
 * top bar.
 */
export default function WidgetShell({
  title,
  id,
  meta,
  bodyClassName = "p-5",
  footer,
  className = "",
  children,
}: WidgetShellProps) {
  return (
    <section id={id} className={`glass relative overflow-hidden scroll-mt-24 ${className}`}>
      <div className="accent-line" aria-hidden="true" />
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] px-5 py-4">
        <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">{title}</h2>
        {meta}
      </header>
      <div className={bodyClassName}>{children}</div>
      {footer ? (
        <div className="border-t border-white/[0.07] px-5 py-3">{footer}</div>
      ) : null}
    </section>
  );
}
