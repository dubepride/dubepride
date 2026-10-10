import type { Metadata } from "next";
import ShiftsConsole from "@/components/ShiftsConsole";

export const metadata: Metadata = {
  title: "Shifts · BIOBRIDGE",
};

export default function ShiftsPage() {
  return <ShiftsConsole />;
}
