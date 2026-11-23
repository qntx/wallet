import { NftTransferError } from "@qntx/wallet-engine";
import type {
  AccountRef,
  NftInventory,
  NftMedia,
  PendingRequest,
  WalletEngine,
} from "@qntx/wallet-engine";

/** Pages one owner's inventory; `cursor === null` ends it, `truncated` means show a gap notice. */
export async function loadInventory(
  engine: WalletEngine,
  owner: string,
  network: string,
): Promise<NftInventory> {
  const first = await engine.nfts.load(owner, network);
  let inventory = first;
  while (inventory.cursor !== null && inventory.failure === null) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- pages are fetched in cursor order
    inventory = await engine.nfts.loadMore(owner, network);
  }
  return inventory;
}

/** Flagged items are hidden by default; a `shown` verdict pins one visible anyway. */
export async function visibleItems(
  engine: WalletEngine,
  inventory: NftInventory,
): Promise<ReadonlyArray<NftInventory["items"][number]>> {
  const flagged = inventory.items.find((item) => item.hidden);
  if (flagged !== undefined) {
    await engine.nfts.setHidden(inventory.network, flagged.id, "shown");
  }
  return inventory.items.filter((item) => !item.hidden);
}

/**
 * A media URL the host may render: `active` media (SVG, HTML, unknown animation) needs a sandbox
 * that runs no script — pass `sandboxed` only when that is true. IPFS goes through the host's own
 * gateway, never a hard-coded one.
 */
export function mediaUrl(
  media: NftMedia | undefined,
  ipfsGateway: (cid: string) => string,
  sandboxed = false,
): string | undefined {
  if (media === undefined || (media.active && !sandboxed)) {
    return undefined;
  }
  if (media.scheme === "ipfs") {
    return ipfsGateway(media.url);
  }
  return media.url;
}

/** An ERC-1155 batch is one request: several ids of one contract to one recipient. */
export async function prepareBatch(
  engine: WalletEngine,
  account: AccountRef,
  contract: string,
  to: string,
  items: ReadonlyArray<{ readonly tokenId: bigint; readonly amount: bigint }>,
): Promise<PendingRequest> {
  return engine.requests.prepare({
    method: "evm-nft-send",
    account,
    network: "eip155:1",
    contract,
    items,
    to,
    fee: "normal",
  });
}

/** Solana takes the SPL mint or the Core asset account — the route verifies which on chain. */
export async function prepareSolana(
  engine: WalletEngine,
  account: AccountRef,
  asset: string,
  to: string,
): Promise<PendingRequest> {
  return engine.requests.prepare({
    method: "solana-nft-send",
    account,
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset,
    to,
    fee: "normal",
  });
}

/** A refused NFT send throws `NftTransferError`; branch on `reason`, never on the message. */
export async function sendOrExplain(
  prepare: () => Promise<PendingRequest>,
): Promise<PendingRequest | string> {
  try {
    return await prepare();
  } catch (error) {
    if (error instanceof NftTransferError) {
      switch (error.reason) {
        case "not-nft":
          return "not an NFT";
        case "not-owned":
          return "the wallet does not hold it";
        case "insufficient-balance":
          return "not enough units";
        case "programmable":
          return "programmable NFTs cannot be sent";
        case "frozen":
          return "the token is frozen";
        case "not-found":
          return "the asset was not found on chain";
      }
    }
    throw error;
  }
}
