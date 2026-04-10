// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: 0,
  use: {
    // Serve the static app on a local dev server.
    baseURL: "http://localhost:3343",
    headless: true,
  },
  webServer: {
    // Simple static file server for the project root.
    command: "npx serve -l 3343 -s .",
    port: 3343,
    reuseExistingServer: true,
  },
});
