/**
 * Offline playground e2e: vault lifecycle + spark chunk laziness. No hosted dependency — the
 * account reaching "connecting"/"ready" or an error state both satisfy the test.
 */
import { expect, test } from "@playwright/test";

const PASSWORD = "correct horse battery staple";

test("create, unlock, account, lock — and the spark chunk stays lazy", async ({ page }) => {
  const sparkRequests: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (/signer-|browser-|spark\.wasm/.test(u)) {
      sparkRequests.push(u);
    }
  });

  await page.goto("/");
  // The spark runtime must not be fetched before an account exists.
  expect(sparkRequests).toStrictEqual([]);

  // Create a wallet (generate mnemonic), then unlock.
  await page.fill("#password", PASSWORD);
  await page.click("#create");
  await expect(page.locator("#status")).toContainText("created", { timeout: 30_000 });
  expect(sparkRequests).toStrictEqual([]);

  await page.click("#unlock");
  await expect(page.locator("#status")).toContainText("unlocked", { timeout: 30_000 });

  // Add the account: the spark chunk may now be requested; the state converges.
  await page.click("#addAccount");
  await expect(page.locator("#accountState")).toContainText(/connecting|ready|error/, {
    timeout: 30_000,
  });

  // Lock resets the view.
  await page.click("#lock");
  await expect(page.locator("#accountState")).toContainText("locked");
  await expect(page.locator("#status")).toContainText("locked");
});
