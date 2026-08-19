import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // Mirrors apcore-cli-typescript so the ecosystem lints alike.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "off", // handled by tsc noUnusedLocals/Params
      "@typescript-eslint/no-non-null-assertion": "warn",
      "no-console": "off",
      "no-undef": "off", // TypeScript handles this
      "no-unused-vars": "off", // handled by tsc
    },
  },
];
