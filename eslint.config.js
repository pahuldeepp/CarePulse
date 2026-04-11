"use strict";

const js = require("@eslint/js");

// Root ESLint config — covers JavaScript tooling and Node services only.
// NestJS TypeScript services use `tsc --noEmit` for type checking (see each
// service's package.json lint script). TypeScript ESLint is wired in S3.

module.exports = [
  { ignores: ["node_modules/**", "dist/**", "**/*.ts"] },
  {
    files: ["**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        console: "readonly",
        module: "readonly",
        process: "readonly",
        require: "readonly",
      },
    },
  },
];
