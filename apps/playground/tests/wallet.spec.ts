/**
 * Offline playground e2e: vault lifecycle + spark chunk laziness. No hosted dependency — the
 * account reaching "connecting"/"ready" or an error state both satisfy the test.
 */
import { expect, test } from "@playwright/test";

const PASSWORD = "correct horse battery staple";

test.setTimeout(120_000);

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

  // Create a wallet (generate mnemonic), then unlock. Creating produces an unlocked session, so
  // the account tree reconciles and drives spark.setAccounts — the signer chunk may load here;
  // laziness is only asserted for the initial page load above.
  await page.fill("#password", PASSWORD);
  await page.click("#create");
  await expect(page.locator("#status")).toContainText("created", { timeout: 30_000 });

  await page.click("#unlock");
  await expect(page.locator("#status")).toContainText("unlocked", { timeout: 30_000 });

  // The reconciled tree already has the wallet's group 0 selected — the spark client starts on
  // its own; add a second group to prove the picker follows the tree.
  await page.click("#addGroup");
  await expect(page.locator("#groupPicker option")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator("#accountState")).toContainText(/connecting|ready|error/, {
    timeout: 30_000,
  });

  // Lock resets the view.
  await page.click("#lock");
  await expect(page.locator("#accountState")).toContainText("locked");
  await expect(page.locator("#status")).toContainText("locked");
});
