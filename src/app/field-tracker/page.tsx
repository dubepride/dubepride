import type { Metadata } from "next";
import FieldTracker from "@/components/FieldTracker";

export const metadata: Metadata = {
  title: "Field Tracker · BIOBRIDGE",
};

/** /field-tracker — live phone locations inside every geofence. */
export default function FieldTrackerPage() {
  return <FieldTracker />;
}
