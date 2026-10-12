import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, whose root is `ui/` for the browser bundle.
// Tests exercise the server-side engine and live at the project root.
export default defineConfig({
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
