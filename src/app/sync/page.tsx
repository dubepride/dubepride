import type { Metadata } from "next";
import SyncConsole from "@/components/SyncConsole";

export const metadata: Metadata = {
  title: "ERP Sync Logs · BIOBRIDGE",
};

/** ERP Sync Logs — delivery diagnostics, payload history, force sync. */
export default function SyncPage() {
  return <SyncConsole />;
}
