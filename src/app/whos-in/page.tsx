import type { Metadata } from "next";
import WhosIn from "@/components/WhosIn";

export const metadata: Metadata = {
  title: "Who's In · BIOBRIDGE",
};

/** /whos-in — Phase 7, Objective 5: live presence roster by branch. */
export default function WhosInPage() {
  return <WhosIn />;
}
