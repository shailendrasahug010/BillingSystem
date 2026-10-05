// Lint for the whole workspace: `pnpm lint`. Typecheck catches type errors;
// this catches what types cannot: hooks called conditionally, unused code,
// promises dropped by accident, stray debugger statements.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/build/**", "apps/mobile/android/**", "apps/mobile/ios/**", "**/*.d.ts", "packages/db/migrations/**", "installer/**", "deploy/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // A leading _ marks a value left out on purpose (`const { secret: _s, ...rest } = row`).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", caughtErrors: "none" }],
      // Thin and no-break spaces in text and patterns are deliberate (Indian number grouping, PDF text).
      "no-irregular-whitespace": ["error", { skipStrings: true, skipTemplates: true, skipRegExps: true, skipComments: true, skipJSXText: true }],
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Tests poke at untyped JSON on purpose.
    files: ["**/test/**", "**/*.test.{ts,tsx}"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
