import type { Metadata } from "next";
import ExceptionsBoard from "@/components/ExceptionsBoard";

export const metadata: Metadata = {
  title: "Exception Resolution · BIOBRIDGE",
};

/** /exceptions — Phase 7, Objective 3: today's flags, filterable. */
export default function ExceptionsPage() {
  return <ExceptionsBoard />;
}
