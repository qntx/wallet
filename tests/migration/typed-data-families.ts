import type { MessageContent, OffchainOrder } from "@qntx/wallet-chains";

/** The protocol union is closed — a host switch must name every order family. */
export function describeOrderProtocol(order: OffchainOrder): string {
  switch (order.protocol) {
    case "1inch":
      return "a 1inch limit order";
    case "uniswapx":
      return "a UniswapX order";
    case "cow":
      return "a CoW order";
    case "0x":
      return "a 0x gasless order";
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the never assignment is the exhaustiveness proof
    default: {
      const exhaustive: never = order.protocol;
      return exhaustive;
    }
  }
}

/** A host renders the recognized typed-data extras before falling back to the generic fields. */
export function describeTypedContent(
  message: Extract<MessageContent, { kind: "typed-data" }>,
): string | undefined {
  const { authorization, authority, farcaster } = message;
  if (authorization !== undefined) {
    switch (authorization.kind) {
      case "transfer":
        return "a transfer authorization anyone can submit";
      case "receive":
        return "a transfer authorization only its recipient can submit";
      case "cancel":
        return "a transfer-authorization cancellation";
    }
  }
  if (authority !== undefined) {
    switch (authority.kind) {
      case "morpho":
        return authority.verified ? "Morpho Blue authority" : "unverified Morpho authority";
      case "aave-credit":
        return authority.verified ? "Aave credit delegation" : "unverified Aave delegation";
      case "snapshot-alias":
        return "a Snapshot alias";
    }
  }
  if (farcaster !== undefined) {
    switch (farcaster.kind) {
      case "add":
        return "a Farcaster signer-key addition";
      case "request":
        return "a Farcaster signer-key request";
    }
  }
  return undefined;
}
