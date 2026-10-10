import type { Metadata } from "next";
import { Suspense } from "react";
import FingerEnrolment, { EnrolmentSkeleton } from "@/components/FingerEnrolment";

export const metadata: Metadata = {
  title: "Fingerprint Enrolment · BIOBRIDGE",
};

/**
 * /employees/[id]/fingerprints — five-finger enrolment console.
 *
 * Static shell (Cache Components friendly): the route param is read client-
 * side via useParams() and both the profile and the connected terminal are
 * fetched from their APIs, so no request-time reads happen at render time.
 *
 * Suspense boundary per the Next.js 16 "blocking prerender client hook"
 * guidance — useParams() suspends while prerendering.
 */
export default function FingerprintPage() {
  return (
    <Suspense fallback={<EnrolmentSkeleton />}>
      <FingerEnrolment />
    </Suspense>
  );
}
