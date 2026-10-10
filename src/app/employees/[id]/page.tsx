import type { Metadata } from "next";
import { Suspense } from "react";
import EmployeeProfile, { TimesheetSkeleton } from "@/components/EmployeeProfile";

export const metadata: Metadata = {
  title: "Employee Timesheet · BIOBRIDGE",
};

/**
 * /employees/[id] — employee profile & weekly timesheet (Objective 4).
 *
 * Static shell (Cache Components friendly): the route param is read client-
 * side via useParams() and the data is fetched from /api/employees/[id],
 * so no request-time reads happen at render time.
 *
 * Because the param isn't known at build time (no generateStaticParams for
 * arbitrary employee IDs), `useParams()` suspends while prerendering — the
 * Suspense boundary lets the skeleton ship in the static shell instead,
 * per the Next.js 16 "blocking prerender client hook" guidance.
 */
export default function EmployeePage() {
  return (
    <Suspense fallback={<TimesheetSkeleton />}>
      <EmployeeProfile />
    </Suspense>
  );
}
