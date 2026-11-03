/**
 * The connect browser test page: `personal_sign` goes through viem's `custom(globalThis.ethereum)`
 * transport — `createWalletClient` + `getAddresses`/`signMessage` route `eth_accounts`/
 * `personal_sign` over the injected provider, then `recoverMessageAddress` recovers the signer.
 * `globalThis.ethereum` is installed by `addInitScript` before this runs.
 */
import { createWalletClient, custom, recoverMessageAddress } from "viem";
import type { Address } from "viem";
import { mainnet } from "viem/chains";

declare global {
  // The injected provider and this page's test surface, installed on the global scope.
  var ethereum: {
    request: (args: { method: string; params?: unknown }) => Promise<unknown>;
    on: (name: string, listener: (payload: unknown) => void) => void;
    removeListener: (name: string, listener: (payload: unknown) => void) => void;
  };
  var ethEvents: unknown[];
  var viemRecover: (message: string) => Promise<string>;
}

const client = createWalletClient({ chain: mainnet, transport: custom(globalThis.ethereum) });

/** `on` events land here so the spec can assert `accountsChanged`/`chainChanged`. */
globalThis.ethEvents = [];
globalThis.ethereum.on("accountsChanged", (payload) => {
  globalThis.ethEvents.push({ accountsChanged: payload });
});
globalThis.ethereum.on("chainChanged", (payload) => {
  globalThis.ethEvents.push({ chainChanged: payload });
});

/** `personal_sign` through viem's `custom(globalThis.ethereum)`, then recover the signer with viem. */
globalThis.viemRecover = async (message: string): Promise<string> => {
  const [account]: ReadonlyArray<Address | undefined> = await client.getAddresses();
  if (account === undefined) {
    throw new Error("no connected account");
  }
  const signature = await client.signMessage({ account, message });
  return recoverMessageAddress({ message, signature });
};
