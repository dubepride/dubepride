import type { Metadata } from "next";
import EmployeeDirectory from "@/components/EmployeeDirectory";

export const metadata: Metadata = {
  title: "Employee Directory · BIOBRIDGE",
};

/** Master employee directory (Phase 5) — static shell; data is fetched client-side. */
export default function EmployeesPage() {
  return <EmployeeDirectory />;
}
