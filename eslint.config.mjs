import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The Expo companion app is its own toolchain (Metro/Hermes, React Native
    // globals) — the Next.js lint config must not walk into it. It is
    // type-checked with `npm run typecheck` from inside mobile/ instead.
    "mobile/**",
  ]),
]);

export default eslintConfig;
