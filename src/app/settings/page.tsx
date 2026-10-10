import type { Metadata } from "next";
import SettingsConsole from "@/components/SettingsConsole";

export const metadata: Metadata = {
  title: "Settings · BIOBRIDGE",
};

export default function SettingsPage() {
  return <SettingsConsole />;
}
