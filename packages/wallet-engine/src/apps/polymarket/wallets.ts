/**
 * Polymarket account location (research.md §1/§1a): a signer's three candidate account wallets —
 * the beacon deposit wallet (current deploys), the UUPS deposit wallet (pre-2026-06-29 deploys) and
 * the legacy Safe — are deterministic CREATE2 addresses. `locate` gathers two evidence channels in
 * parallel: the unauthenticated relayer's `GET /deployed` answers (hints only — nothing is trusted
 * from them alone) and `eth_getCode` on all three candidates via the Polygon RPC, cross-checked
 * against the host endpoint when one is configured. Chain facts decide: an empty read means not
 * deployed; a deployed deposit wallet's code must equal the template's expected runtime exactly;
 * any disagreement — relayer vs chain, primary vs host endpoint, or code that is not the template —
 * throws `deployment-mismatch` and nothing is chosen. Only then does the settled priority pick: a
 * deployed UUPS (it can only be an old account), else a deployed beacon, else a deployed Safe
 * (read-only until migrated — the enable flow surfaces `needs-migration`), else the undeployed
 * beacon address the enable flow will deploy. The Magic "Proxy" derivation is intentionally absent:
 * its signers are Magic-managed keys, never a BIP-44 account of this wallet.
 *
 * The init-code formulas are Solady LibClone's `initCodeHashERC1967BeaconProxy` /
 * `initCodeHashERC1967` (MIT): `keccak256(uint80BE(prefix + (len(args) << 56)) ‖ target ‖ runtime ‖
 * args)` with `args = abi.encode(address factory, bytes32 leftPad32(signer))` and `salt =
 * keccak256(args)` (docs trading/wallets-auth.md §Derive a Deposit Wallet Address). The oracle is
 * on-chain owner state, not the SDK — vectors/chains/polymarket-wallets.json.
 */
import {
  concat,
  encodeAbiParameters,
  getCreate2Address,
  keccak256,
  numberToHex,
  padHex,
} from "viem";

import { evmRpcHex } from "../../chains/evm.ts";
import type { NetworkController } from "../../networks/controller.ts";
import {
  DEPOSIT_WALLET_BEACON,
  DEPOSIT_WALLET_FACTORY,
  DEPOSIT_WALLET_IMPLEMENTATION,
  RELAYER_HOST,
  SAFE_FACTORY,
  SAFE_INIT_CODE_HASH,
} from "./constants.ts";
import { PolymarketError } from "./errors.ts";
import type { PolymarketHttp } from "./http.ts";
import { relayerDeployed } from "./schemas.ts";

export type PolymarketWalletCandidates = {
  /** The current deposit-wallet template — where a fresh account deploys. */
  readonly beacon: `0x${string}`;
  /** The pre-2026-06-29 deposit-wallet template. */
  readonly uups: `0x${string}`;
  /** The legacy Safe account. */
  readonly safe: `0x${string}`;
};

export type PolymarketAccount = {
  /** The group's `evm.bip44` address — the CLOB `POLY_ADDRESS`/owner. */
  readonly signer: `0x${string}`;
  /** The account address positions/value/orders reads scope to. */
  readonly wallet: `0x${string}`;
  readonly kind: "deposit-wallet" | "safe";
  readonly deployed: boolean;
  /** A deployed legacy Safe alongside a live deposit wallet — read-only display. */
  readonly legacySafe?: `0x${string}`;
};

export type PolymarketWallets = {
  readonly derive: (signer: `0x${string}`) => PolymarketWalletCandidates;
  readonly locate: (signer: `0x${string}`) => Promise<PolymarketAccount>;
};

/* Solady LibClone bytecode, verbatim between the computed segments. */
const BEACON_PREFIX = 0x6100523d8160233d3973n;
const BEACON_RUNTIME: ReadonlyArray<`0x${string}`> = [
  "0x60195155f3363d3d373d3d363d602036600436635c60da",
  "0x1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6c",
  "0xb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3",
];
const UUPS_PREFIX = 0x61003d3d8160233d3973n;
const UUPS_RUNTIME: ReadonlyArray<`0x${string}`> = [
  "0x6009",
  "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076",
  "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3",
];

const isSigner = (signer: string): signer is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(signer);

/** `1 << 56` as a multiplier — the args length lands in the prefix's third byte. */
const BYTE56 = 0x1_00_00_00_00_00_00_00n;

/**
 * The PUSH2 length prefix: the constant already encodes the runtime size, and the args length is
 * added into its top bytes — `uint80BE(prefix + (len << 56))` per the Solady formula.
 */
const prefixFor = (prefix: bigint, argsBytes: number): `0x${string}` =>
  numberToHex(prefix + BigInt(argsBytes) * BYTE56, { size: 10 });

/* `args` embeds the factory and the left-padded signer; the same args feed both deposit templates'
   init code, the shared salt and the expected runtime `locate` verifies. */
const depositArgs = (signer: `0x${string}`): `0x${string}` =>
  encodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }],
    [DEPOSIT_WALLET_FACTORY, padHex(signer, { size: 32 })],
  );

/**
 * The runtime the deployed deposit-wallet proxy carries: the init code minus its creation part —
 * the runtime segments concatenated with `args`, dropping the first 5 bytes (the constructor tail
 * `PUSH1 slot-offset; MLOAD; SSTORE; RETURN` that stores the template in the ERC-1967 slot: `60 19
 * 51 55 f3` beacon, `60 09 51 55 f3` UUPS).
 */
export const expectedPolymarketWalletRuntime = (
  kind: "beacon" | "uups",
  signer: `0x${string}`,
): `0x${string}` => {
  const init = concat([
    ...(kind === "beacon" ? BEACON_RUNTIME : UUPS_RUNTIME),
    depositArgs(signer),
  ]);
  return `0x${init.slice(12)}`;
};

export const derivePolymarketWallets = (signer: `0x${string}`): PolymarketWalletCandidates => {
  const given: string = signer;
  if (!isSigner(given)) {
    throw new PolymarketError("invalid-input", `bad signer address ${given}`);
  }
  const args = depositArgs(signer);
  const salt = keccak256(args);
  const argsBytes = (args.length - 2) / 2;
  const beacon = getCreate2Address({
    from: DEPOSIT_WALLET_FACTORY,
    salt,
    bytecodeHash: keccak256(
      concat([prefixFor(BEACON_PREFIX, argsBytes), DEPOSIT_WALLET_BEACON, ...BEACON_RUNTIME, args]),
    ),
  });
  const uups = getCreate2Address({
    from: DEPOSIT_WALLET_FACTORY,
    salt,
    bytecodeHash: keccak256(
      concat([
        prefixFor(UUPS_PREFIX, argsBytes),
        DEPOSIT_WALLET_IMPLEMENTATION,
        ...UUPS_RUNTIME,
        args,
      ]),
    ),
  });
  /* The Safe salts on the bare signer and keeps the recorded init-code hash — Polymarket's own
     one-owner Safe configuration is baked into it. */
  const safe = getCreate2Address({
    from: SAFE_FACTORY,
    salt: keccak256(encodeAbiParameters([{ type: "address" }], [signer])),
    bytecodeHash: SAFE_INIT_CODE_HASH,
  });
  return { beacon, uups, safe };
};

const NETWORK = "eip155:137";

/* `undefined`/`"0x"` are both the empty read. */
const emptyCode = (code: string | undefined): boolean =>
  code === undefined || code === "0x" || code === "";

export function createPolymarketWallets(
  http: PolymarketHttp,
  networks: Pick<NetworkController, "client" | "independentClient">,
): PolymarketWallets {
  const deployed = async (address: `0x${string}`, type: "WALLET" | "SAFE"): Promise<boolean> => {
    const answer = await http.request(
      { host: RELAYER_HOST, method: "GET", path: "/deployed", query: { address, type } },
      relayerDeployed,
    );
    return answer.deployed;
  };

  return {
    derive: derivePolymarketWallets,
    locate: async (signer) => {
      const candidates = derivePolymarketWallets(signer);
      const chainCode = async (address: `0x${string}`) =>
        evmRpcHex(networks.client(NETWORK), "eth_getCode", [address, "latest"]);
      const independent = networks.independentClient(NETWORK);
      /* Relayer hints and chain reads in parallel — the hints decide nothing until the chain
         agrees. A host endpoint that cannot answer fails closed (`unavailable`): a missing
         cross-check is not permission to trust the primary alone. */
      const [uupsHint, beaconHint, safeHint, codes, other] = await Promise.all([
        deployed(candidates.uups, "WALLET"),
        deployed(candidates.beacon, "WALLET"),
        deployed(candidates.safe, "SAFE"),
        Promise.all([
          chainCode(candidates.uups),
          chainCode(candidates.beacon),
          chainCode(candidates.safe),
        ]),
        independent.kind === "available"
          ? Promise.all([
              evmRpcHex(independent.client, "eth_getCode", [candidates.uups, "latest"]),
              evmRpcHex(independent.client, "eth_getCode", [candidates.beacon, "latest"]),
              evmRpcHex(independent.client, "eth_getCode", [candidates.safe, "latest"]),
            ]).catch((error: unknown) => {
              throw new PolymarketError(
                "unavailable",
                "the host endpoint could not read the account wallets",
                { cause: error },
              );
            })
          : Promise.resolve(undefined),
      ]);
      /* Primary and host endpoint must agree byte-for-byte before anything is trusted. */
      const codeOf = (index: number): string | undefined => {
        const primary = codes[index];
        const secondary = other?.[index];
        if (secondary !== undefined && primary?.toLowerCase() !== secondary.toLowerCase()) {
          throw new PolymarketError(
            "deployment-mismatch",
            "the chain RPC and the host endpoint disagree on the account wallet's code",
          );
        }
        return primary;
      };
      /* A non-empty deposit-wallet code must be the template's expected runtime exactly — the
         address derivation is only half the proof. */
      const deployedByChain = (index: number, kind: "beacon" | "uups"): boolean => {
        const code = codeOf(index);
        if (emptyCode(code)) {
          return false;
        }
        if (
          code !== undefined &&
          code.toLowerCase() !== expectedPolymarketWalletRuntime(kind, signer).toLowerCase()
        ) {
          throw new PolymarketError(
            "deployment-mismatch",
            `the code at the ${kind} candidate is not the deposit-wallet template`,
          );
        }
        return true;
      };
      /* The Safe's CREATE2 address already commits to SAFE_INIT_CODE_HASH — any code means
         deployed; the deposit wallets are proven by template above. */
      const uupsUp = deployedByChain(0, "uups");
      const beaconUp = deployedByChain(1, "beacon");
      const safeUp = !emptyCode(codeOf(2));
      /* Every relayer hint must match the chain's verdict — a hint is evidence only as a
         cross-check, never as the decision. */
      const hints: ReadonlyArray<[string, boolean, boolean]> = [
        ["uups", uupsHint, uupsUp],
        ["beacon", beaconHint, beaconUp],
        ["safe", safeHint, safeUp],
      ];
      for (const [name, hint, chain] of hints) {
        if (hint !== chain) {
          throw new PolymarketError(
            "deployment-mismatch",
            `the relayer claims the ${name} candidate is ${hint ? "" : "not "}deployed but the chain disagrees`,
          );
        }
      }
      const legacySafe = safeUp ? { legacySafe: candidates.safe } : {};
      /* UUPS first — a wallet there is necessarily an old account (design.md §locate). */
      if (uupsUp) {
        return {
          signer,
          wallet: candidates.uups,
          kind: "deposit-wallet",
          deployed: true,
          ...legacySafe,
        };
      }
      if (beaconUp) {
        return {
          signer,
          wallet: candidates.beacon,
          kind: "deposit-wallet",
          deployed: true,
          ...legacySafe,
        };
      }
      if (safeUp) {
        return { signer, wallet: candidates.safe, kind: "safe", deployed: true };
      }
      /* Nothing deployed: the enable flow will deploy the beacon derivation. */
      return { signer, wallet: candidates.beacon, kind: "deposit-wallet", deployed: false };
    },
  };
}
