import Avatar from "@/components/Avatar";
import WidgetShell from "@/components/WidgetShell";
import { OVERTIME_ROWS } from "@/lib/dashboard-mock";

/**
 * Widget C — Approaching Overtime (bottom left).
 *
 * Weekly totals with the remaining buffer before the first overtime tier
 * (OT1). Rows near the threshold flip to an amber "NEAR OT" chip; safe
 * rows stay neon green.
 */
export default function OvertimeCard() {
  return (
    <WidgetShell
      title="Approaching Overtime"
      meta={<span className="chip chip--muted">This week</span>}
      bodyClassName="p-0"
      footer={
        <p className="text-[11px] text-muted">
          Thresholds: OT1 at 40h (Mon–Sat) · buffer recalculated after every
          synced punch.
        </p>
      }
    >
      <div className="scroll-thin overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left">
          <thead className="tbl-head">
            <tr>
              <th>Name</th>
              <th>Worked Hours</th>
              <th>Approaching</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {OVERTIME_ROWS.map((r) => (
              <tr key={r.employeeId} className="tbl-row">
                <td>
                  <span className="flex items-center gap-3">
                    <Avatar name={r.name} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-ink">
                        {r.name}
                      </span>
                      <span className="block truncate text-[11px] text-muted">
                        {r.erpUserId} · {r.department}
                      </span>
                    </span>
                  </span>
                </td>
                <td className="whitespace-nowrap font-mono text-sm font-semibold text-ink tabular-nums">
                  {r.worked}{" "}
                  <span className="text-xs font-normal text-muted">(Weekly)</span>
                </td>
                <td className="whitespace-nowrap font-mono text-sm font-semibold text-ink tabular-nums">
                  {r.approaching}
                </td>
                <td>
                  <span
                    className={
                      r.status === "NEAR OT" ? "chip chip--warn" : "chip chip--neon"
                    }
                  >
                    {r.status === "NEAR OT" ? "Near OT" : "On Track"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </WidgetShell>
  );
}
