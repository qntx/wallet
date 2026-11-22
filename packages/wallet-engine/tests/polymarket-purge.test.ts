// oxlint-disable vitest/no-conditional-in-test -- the world's optional `pm` member needs
// narrowing before use (same convention as polymarket-enable.test.ts).

/**
 * An open `live.account` view must not keep its credentials past a delete: `disable` removes the
 * record through the credential store and the view stops `not-enabled` instead of re-sending the
 * auth frame on its next reconnect. The world's socket never opens, so the view only proves the
 * stop lands — `polymarket-live.test.ts` covers the socket-side close and reconnect suppression.
 */
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import { MNEMONIC, tick, world } from "./apps-helpers.ts";

const OWNER = mnemonicToAccount(MNEMONIC, { addressIndex: 0 }).address;
const CREDS = {
  owner: OWNER,
  apiKey: "7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a2",
  secret: "lqe4ydrr/A0eL0BRYnOElaa3yNnq+wwdLj9QYXKDlKU=",
  passphrase: "test-passphrase-1",
};

describe("polymarket purge — a deleted record stops its live account view", () => {
  it("disable deletes the credentials and the open view stops not-enabled", async () => {
    const w = await world(0, { hyperliquid: false, polymarket: {} });
    if (w.pm === undefined) {
      throw new Error("the world has no polymarket provider");
    }
    await w.credentials.put(w.group, CREDS);
    const view = w.pm.live.account(w.group);
    await tick();
    await w.apps.disable(w.group, "polymarket", { revoke: false });
    expect(view.getState().status).toBe("stale");
    expect(view.getState().error).toBe("not-enabled");
    await expect(w.credentials.get(w.group)).resolves.toBeUndefined();
  });
});
