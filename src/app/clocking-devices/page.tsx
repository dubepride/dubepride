import type { Metadata } from "next";
import ClockingDevices from "@/components/ClockingDevices";

export const metadata: Metadata = {
  title: "Clocking Devices · BIOBRIDGE",
};

export default function ClockingDevicesPage() {
  return <ClockingDevices />;
}
