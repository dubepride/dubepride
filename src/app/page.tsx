import type { Metadata } from "next";
import DashboardBody from "@/components/DashboardBody";
import MasterClock from "@/components/MasterClock";

export const metadata: Metadata = {
  title: "Dashboard · BIOBRIDGE",
};

/**
 * Main Dashboard — Master Clock centred at the top, live metrics and the
 * real-time scan feed below. Static shell (Cache Components friendly);
 * every number is polled from the API routes on the client.
 */
export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <MasterClock />
      <DashboardBody />
    </div>
  );
}
