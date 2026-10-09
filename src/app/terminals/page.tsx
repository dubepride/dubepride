import type { Metadata } from "next";
import TerminalManager from "@/components/TerminalManager";

export const metadata: Metadata = {
  title: "Terminal Manager · BIOBRIDGE",
};

export default function TerminalsPage() {
  return <TerminalManager />;
}
