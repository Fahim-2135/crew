import js from "@eslint/js";
import globals from "globals";

// Flat config. Prettier owns formatting; ESLint owns correctness.
export default [
  { ignores: ["node_modules/**", "spikes/**", "app/**"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  // The Crew window runs in the browser.
  { files: ["hub/web/**"], languageOptions: { globals: { ...globals.browser } } },
];
