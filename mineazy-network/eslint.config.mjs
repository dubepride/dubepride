/**
 * ESLint flat configuration.
 *
 * `eslint-config-next` v16 ships native flat configs, so they are used
 * directly — the old `FlatCompat` bridge cannot load them and crashes with
 * "Converting circular structure to JSON".
 */

import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "data/**",
      "next-env.d.ts",
      "**/*.d.ts",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      /**
       * A name that starts with an underscore is deliberately unused — it is
       * the conventional way to drop a property from an object
       * (`const { passwordHash: _passwordHash, ...user } = row`) or to name a
       * parameter that the signature requires but the body does not need.
       */
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          args: "all",
          caughtErrors: "none",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
];

export default config;
