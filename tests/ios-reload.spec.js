// @ts-check
const { test, expect } = require("@playwright/test");

/*
 * Simulate an iOS-Safari-style page reload after a bus departure.
 *
 * On iOS Safari the page is frequently discarded and reloaded from scratch
 * when the user switches tabs or locks the phone. The app persists the
 * "last departed" timestamp in localStorage so the "left X ago" badge can
 * survive these reloads.
 *
 * Test plan:
 *   1. Seed localStorage with a recent departure timestamp for both cards.
 *   2. Reload the page (simulates the iOS discard → restore cycle).
 *   3. Assert that the "left X ago" badge is visible.
 *   4. Clear localStorage and reload again.
 *   5. Assert that the badge is gone.
 */

const CARDS = [
  { cardId: "card-home-to-station", lsKey: "bus343_ld_card-home-to-station" },
  { cardId: "card-station-to-home", lsKey: "bus343_ld_card-station-to-home" },
];

for (const { cardId, lsKey } of CARDS) {
  test.describe(`localStorage badge persistence — ${cardId}`, () => {
    test("badge shows 'left X ago' after page reload when localStorage has a recent departure", async ({
      page,
    }) => {
      // Navigate once so we have a page context for localStorage manipulation.
      await page.goto("/");

      // Seed localStorage: pretend a bus departed 90 seconds ago.
      const departedTs = Math.floor(Date.now() / 1000) - 90;
      await page.evaluate(
        ({ key, ts }) => localStorage.setItem(key, String(ts)),
        { key: lsKey, ts: departedTs }
      );

      // --- iOS Safari reload simulation ---
      // On iOS, when a page is restored the entire JS context is torn down
      // and the page is reloaded fresh. A normal location.reload() does
      // exactly this from the app's perspective.
      await page.reload();

      // The badge element should now contain text like "left 1m ago".
      const badge = page.locator(`#${cardId}-last-left`);
      await expect(badge).not.toBeEmpty({ timeout: 10_000 });
      const text = await badge.textContent();
      expect(text).toMatch(/left \d+(s|m) ago/);
    });

    test("badge disappears after localStorage is cleared and page reloads", async ({
      page,
    }) => {
      await page.goto("/");

      // Seed a departure so the badge appears.
      const departedTs = Math.floor(Date.now() / 1000) - 60;
      await page.evaluate(
        ({ key, ts }) => localStorage.setItem(key, String(ts)),
        { key: lsKey, ts: departedTs }
      );
      await page.reload();

      // Sanity check: badge should be visible after reload.
      const badge = page.locator(`#${cardId}-last-left`);
      await expect(badge).not.toBeEmpty({ timeout: 10_000 });

      // --- Clear localStorage (simulates user clearing site data) ---
      await page.evaluate(() => localStorage.clear());
      await page.reload();

      // The badge should now be empty (CSS hides :empty via display:none).
      await expect(badge).toBeEmpty({ timeout: 10_000 });
    });
  });
}
