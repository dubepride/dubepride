import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import AppChrome from "@/components/AppChrome";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BIOBRIDGE · Biometric Time & Attendance",
  description:
    "Enterprise bridge between IP fingerprint terminals and the central ERP — live attendance, terminal health and ERP synchronisation.",
};

/**
 * Static shell for the Suspense fallback: a same-size left rail (lg+) and
 * a same-height header bar, so streaming into /employees/[id] causes no
 * layout shift when usePathname() suspends.
 */
function ChromeFallback() {
  return (
    <div aria-hidden="true">
      <div className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-white/[0.06] bg-void/70 backdrop-blur-xl lg:block" />
      <div className="sticky top-0 z-40 h-16 border-b border-white/[0.06] bg-void/75 backdrop-blur-xl lg:pl-64" />
    </div>
  );
}

/**
 * Root layout — fixed left navigation rail + sticky top bar (both read
 * usePathname(), so they sit inside one Suspense boundary: on routes that
 * can't be fully prerendered the hook suspends and the fallback renders a
 * same-shape chrome; on static routes the real chrome resolves during
 * prerender and the fallback never shows). The rail occupies 16rem at
 * lg+, which the `lg:pl-64` wrapper clears so page content never slides
 * under it.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-screen flex-col">
        <Suspense fallback={<ChromeFallback />}>
          <AppChrome />
        </Suspense>
        <div className="flex flex-1 flex-col lg:pl-64">
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-7 sm:px-6 lg:px-8">
            {children}
          </main>
          <footer className="border-t border-white/5 px-4 py-5 text-center text-[11px] tracking-[0.14em] text-muted uppercase">
            BIOBRIDGE · Enterprise Biometric Time &amp; Attendance Bridge · push
            endpoint <span className="font-mono text-neon">/api/biometrics/push</span>
          </footer>
        </div>
      </body>
    </html>
  );
}
