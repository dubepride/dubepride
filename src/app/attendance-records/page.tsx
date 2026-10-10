import type { Metadata } from "next";
import AttendanceRecords from "@/components/AttendanceRecords";

export const metadata: Metadata = {
  title: "Attendance Records · BIOBRIDGE",
};

/** Day-grouped attendance log (Phase 11) — static shell; data is fetched client-side. */
export default function AttendanceRecordsPage() {
  return <AttendanceRecords />;
}
