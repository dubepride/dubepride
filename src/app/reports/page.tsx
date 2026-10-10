import type { Metadata } from "next";
import ReportsDashboard from "@/components/ReportsDashboard";

export const metadata: Metadata = {
  title: "Reports · BIOBRIDGE",
};

export default function ReportsPage() {
  return <ReportsDashboard />;
}
