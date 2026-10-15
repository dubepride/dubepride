import type { Metadata } from "next";
import AttendanceRecords from "@/components/AttendanceRecords";
import GeofenceActivity from "@/components/GeofenceActivity";

export const metadata: Metadata = {
  title: "Attendance Records · BIOBRIDGE",
};

/** Day-grouped attendance log (Phase 11) + the mobile GPS clocking audit (Phase 18). */
export default function AttendanceRecordsPage() {
  return (
    <div className="space-y-6">
      <AttendanceRecords />
      <GeofenceActivity />
    </div>
  );
}
