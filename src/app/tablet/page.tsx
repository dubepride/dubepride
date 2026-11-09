import type { Metadata } from "next";
import TabletStation from "@/components/TabletStation";

export const metadata: Metadata = {
  title: "Tablet Clocking Station · BIOBRIDGE",
  description: "Touch-optimised kiosk clocking station for work tablets and shared site devices.",
};

export default function TabletPage() {
  return <TabletStation />;
}
