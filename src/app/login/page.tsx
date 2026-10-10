import type { Metadata } from "next";
import LoginForm from "@/components/LoginForm";

export const metadata: Metadata = {
  title: "Sign in · BIOBRIDGE",
};

/**
 * /login — the only publicly reachable page (Objective 1).
 * Static shell rendering the enterprise sign-in form; no developer hints
 * are shown (default credentials live in README.md instead).
 */
export default function LoginPage() {
  return <LoginForm />;
}
