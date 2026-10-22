/**
 * ============================================================================
 *  (console)/layout.tsx — the frame for every signed-in screen
 * ============================================================================
 *
 *  The AuthProvider resolves the session once; the shell then renders the
 *  navigation and the screen inside it.
 * ============================================================================
 */

import { AuthProvider } from "@/components/auth";
import { ConsoleShell } from "@/components/ConsoleShell";

/**
 * Every console screen is a client-rendered dashboard: it reads the signed-in
 * account, the live topology and the collector heartbeat from /api/* after it
 * loads, and the active nav entry is derived from the URL pathname. None of
 * that is knowable at build time, so the console segment is declared blocking
 * rather than pretending to have a static shell.
 */
export const instant = false;

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ConsoleShell>{children}</ConsoleShell>
    </AuthProvider>
  );
}
