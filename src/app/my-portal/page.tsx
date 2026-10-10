import type { Metadata } from "next";
import MyPortal from "@/components/MyPortal";

export const metadata: Metadata = {
  title: "My Portal · BIOBRIDGE",
};

export default function MyPortalPage() {
  return <MyPortal />;
}