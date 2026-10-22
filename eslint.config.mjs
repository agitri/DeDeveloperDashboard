import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "out/", "node_modules/"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // `void somePromise()` is the house style for fire-and-forget; an
      // unmarked floating promise is still a bug.
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // `async` marks a function as promise-returning even when nothing inside
      // awaits — the command table and the fetch stubs rely on that uniformity.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // Tests stub fetch, fs and timers and reach into whatever comes back.
    files: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-base-to-string": "off",
    },
  },
  {
    // The main and preload processes run in Node; core must stay portable
    // (see core/no-electron.test.ts), so it gets Node globals but nothing else.
    files: ["src/{core,main,preload,shared}/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      // zustand selectors (`useStore((s) => s.action)`) hand out store methods
      // that never read `this`; the rule cannot tell and fires on every one.
      "@typescript-eslint/unbound-method": "off",
    },
  },
);
