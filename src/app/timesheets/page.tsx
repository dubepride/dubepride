import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Timesheets · BIOBRIDGE",
};

/**
 * /timesheets — Phase 7, Objective 4.
 *
 * The multi-punch weekly logic (Mon→Sat grouping, chronological
 * In/Out/In/Out, total valid hours) already lives in /employees/[id],
 * so per the spec this route hands the admin to the employee directory
 * with the search box focused (?focus=search → EmployeeDirectory's
 * mount effect autofocuses the input).
 */
export default function TimesheetsPage() {
  redirect("/employees?focus=search");
}
