/// <reference types="node" />
// oxlint-disable eslint/no-await-in-loop -- requests are sequential and throttled by design
/**
 * Regenerates vectors/chains/evm-cctp.json: the CCTP TokenMessengerV2 `depositForBurnWithHook`
 * Hyperliquid deposits the EVM decoder describes, plus the near-miss calls that must stay blind
 * (`cctp-destination`).
 *
 * Two oracles: the described/near-miss calldata is built independently with viem's
 * `encodeFunctionData` (the decoder uses ox), and the last four vectors carry the real calldata of
 * mainnet deposits fetched by eth_getTransactionByHash from https://arb1.arbitrum.io/rpc (evidence:
 * n3/f5-residual/evidence/H-1/mainnet-direct-deposits.txt).
 *
 * Run from the repo root: bun scripts/vectors/cctp.ts
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the CJS require is untyped
const { encodeFunctionData, getAddress, parseAbi } = require("viem") as {
  encodeFunctionData: (args: {
    abi: unknown;
    functionName: string;
    args: ReadonlyArray<unknown>;
  }) => string;
  getAddress: (addr: string) => string;
  parseAbi: (entries: ReadonlyArray<string>) => unknown;
};

const RPC = "https://arb1.arbitrum.io/rpc";
const OUT = "vectors/chains/evm-cctp.json";

const ARB_ABI = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

const MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const MESSENGER_SEPOLIA = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDC_SEPOLIA = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
const FORWARDER = "0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757";
const FORWARDER_SEPOLIA = "0x02e39ECb8368b41bF68FF99ff351aC9864e5E2a2";
const SIGNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const USDC_DECIMALS = 6;

const pad32 = (addr: string): `0x${string}` => `0x${addr.slice(2).padStart(64, "0")}`;

/** The 56-byte `cctp-forward` hook — the layout the decoder and the forwarder both read. */
const hook = (recipient: string, dex: "perps" | "spot"): `0x${string}` =>
  `0x636374702d666f7277617264${"00".repeat(12)}0000000000000018${recipient
    .slice(2)
    .toLowerCase()}${dex === "perps" ? "00000000" : "ffffffff"}` as `0x${string}`;

const depositData = (o: {
  amount?: bigint;
  domain?: number;
  mintRecipient?: `0x${string}`;
  burnToken?: `0x${string}`;
  destinationCaller?: `0x${string}`;
  maxFee?: bigint;
  finality?: number;
  hookData?: `0x${string}`;
}): string =>
  encodeFunctionData({
    abi: ARB_ABI,
    functionName: "depositForBurnWithHook",
    args: [
      o.amount ?? 5_000_000n,
      o.domain ?? 19,
      o.mintRecipient ?? pad32(FORWARDER),
      o.burnToken ?? USDC,
      o.destinationCaller ?? pad32(FORWARDER),
      o.maxFee ?? 200_000n,
      o.finality ?? 1000,
      o.hookData ?? hook(SIGNER, "perps"),
    ],
  });

const baseTx = {
  type: "0x2",
  chainId: "0xa4b1",
  nonce: "0x1",
  gas: "0x30000",
  maxFeePerGas: "0x59682f00",
  maxPriorityFeePerGas: "0x3b9aca00",
  gasPrice: "0x59682f00",
  value: "0x0",
};

const usdc = (amount: bigint) => ({
  asset: USDC,
  amount: amount.toString(10),
  decimals: USDC_DECIMALS,
  symbol: "USDC",
});
/* Sepolia USDC is not in the token table — no decimals/symbol metadata is emitted. */
const usdcSepolia = (amount: bigint) => ({ asset: USDC_SEPOLIA, amount: amount.toString(10) });

const described = (
  name: string,
  tx: { to: string; data: string },
  amount: bigint,
  maxFee: bigint,
  dex: "perps" | "spot",
  sepolia = false,
) => ({
  name,
  signer: SIGNER,
  tx: { ...baseTx, ...(sepolia ? { chainId: "0x66eee" } : {}), ...tx },
  expect: {
    summary: "transfer",
    verifiability: "partial",
    outflows: [{ to: tx.to, amount: (sepolia ? usdcSepolia : usdc)(amount), verified: true }],
    hyperliquidDeposit: {
      recipient: SIGNER,
      dex,
      maxFee: (sepolia ? usdcSepolia : usdc)(maxFee),
    },
  },
});

const blind = (name: string, tx: { to?: string; data: string; value?: string }) => ({
  name,
  signer: SIGNER,
  tx: { ...baseTx, to: MESSENGER, ...tx },
  expect: { verifiability: "opaque", blind: "cctp-destination" },
});

const real = (name: string, tx: Record<string, unknown>, signer: string, expect: unknown) => ({
  name,
  signer,
  tx: {
    to: tx["to"],
    value: tx["value"],
    data: tx["input"],
    type: "0x2",
    chainId: "0xa4b1",
    nonce: tx["nonce"],
    gas: tx["gas"],
    maxFeePerGas: tx["maxFeePerGas"],
    maxPriorityFeePerGas: tx["maxPriorityFeePerGas"],
    gasPrice: tx["gasPrice"],
  },
  expect,
});

const REAL_TXS: ReadonlyArray<{
  readonly hash: string;
  readonly from: string;
  readonly amount: bigint;
  readonly described: boolean;
  readonly dex: "perps" | "spot";
}> = [
  {
    hash: "0x888454daf721514f73f94ec35ffc7804a2e91d57dc5d713b04686ae4fe281a23",
    from: "0x819a8ff3832840adc4c60346a1f239431ad1f219",
    amount: 300_000_000n,
    described: true,
    dex: "perps",
  },
  {
    hash: "0xd4e45820f8885c099bea3b3763bb855208ab7fef4326c99322f4b3029fafbe31",
    from: "0x035c3f2fb485ce0408c3eda5314de4ad9926fc64",
    amount: 751_830_000n,
    described: true,
    dex: "perps",
  },
  {
    /* The forwarder hook sends this deposit to a different recipient than the signer —
       the decoder must stay blind. */
    hash: "0x3bfbe14328667626079741a02f8ff35946d1f9ee301d186455e38fb254b85d63",
    from: "0x7de1fce5f71cc82c44397b1d61436ef67e743239",
    amount: 6_000_661_120n,
    described: false,
    dex: "spot",
  },
  {
    hash: "0x30dddef9c5831c8c621f7e702821bb542cc91f40a3cdc1c5af6c37ac0080dfbe",
    from: "0xc3c917098727b591a0bb3a38e409254af7bd13d6",
    amount: 1_038_400_000n,
    described: true,
    dex: "perps",
  },
];

const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body: unknown = await res.json();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the RPC envelope is untyped
  const record = body as Record<string, unknown> | undefined;
  if (record?.["result"] === undefined) {
    throw new TypeError(`${method} failed: ${JSON.stringify(record?.["error"])}`);
  }
  return record["result"];
};

const vectors: unknown[] = [
  described(
    "deposit 5 USDC perps (viem-encoded)",
    { to: MESSENGER, data: depositData({}) },
    5_000_000n,
    200_000n,
    "perps",
  ),
  described(
    "deposit 5 USDC spot",
    { to: MESSENGER, data: depositData({ hookData: hook(SIGNER, "spot") }) },
    5_000_000n,
    200_000n,
    "spot",
  ),
  described(
    "deposit 7.5 USDC perps on Arbitrum Sepolia",
    {
      to: MESSENGER_SEPOLIA,
      data: depositData({
        amount: 7_500_000n,
        burnToken: USDC_SEPOLIA,
        mintRecipient: pad32(FORWARDER_SEPOLIA),
        destinationCaller: pad32(FORWARDER_SEPOLIA),
      }),
    },
    7_500_000n,
    200_000n,
    "perps",
    true,
  ),
  blind("nonzero value", { data: depositData({}), value: "0x1" }),
  blind("trailing byte", { data: `${depositData({})}00` }),
  blind("wrong burnToken", { data: depositData({ burnToken: SIGNER }) }),
  blind("wrong domain", { data: depositData({ domain: 3 }) }),
  blind("wrong mintRecipient", { data: depositData({ mintRecipient: pad32(SIGNER) }) }),
  blind("wrong destinationCaller", { data: depositData({ destinationCaller: pad32(SIGNER) }) }),
  blind("hook recipient is not the signer", {
    data: depositData({
      hookData: hook("0x1111111111111111111111111111111111111111", "perps"),
    }),
  }),
  blind("hook dex is neither selector", {
    data: depositData({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook stays 0x-prefixed
      hookData: `${hook(SIGNER, "perps").slice(0, -8)}00000001` as `0x${string}`,
    }),
  }),
  blind("hook version is not zero", {
    data: depositData({
      hookData: `0x636374702d666f7277617264${"00".repeat(12)}0000000100000018${SIGNER.slice(
        2,
      )}00000000` as `0x${string}`,
    }),
  }),
  blind("hook length is not 24", {
    data: depositData({
      hookData: `0x636374702d666f7277617264${"00".repeat(12)}0000000000000017${SIGNER.slice(
        2,
      )}00000000` as `0x${string}`,
    }),
  }),
  blind("hook zeros are nonzero", {
    data: depositData({
      hookData: `0x636374702d666f727761726401${"00".repeat(11)}0000000000000018${SIGNER.slice(
        2,
      )}00000000` as `0x${string}`,
    }),
  }),
  blind("hook tag is not cctp-forward", {
    data: depositData({
      hookData: `0x636374702d666f727761726500${"00".repeat(11)}0000000000000018${SIGNER.slice(
        2,
      )}00000000` as `0x${string}`,
    }),
  }),
  blind("maxFee equals amount", { data: depositData({ maxFee: 5_000_000n }) }),
  blind("zero maxFee", { data: depositData({ maxFee: 0n }) }),
];

for (const r of REAL_TXS) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the RPC envelope is untyped
  const tx = (await rpc("eth_getTransactionByHash", [r.hash])) as
    | Record<string, unknown>
    | undefined;
  if (typeof tx?.["from"] !== "string") {
    throw new TypeError(`cannot fetch ${r.hash}`);
  }
  if (tx["from"].toLowerCase() !== r.from) {
    throw new TypeError(`${r.hash} moved: from is ${tx["from"]}`);
  }
  vectors.push(
    real(
      `real mainnet deposit ${r.hash.slice(0, 10)}…`,
      tx,
      r.from,
      r.described
        ? {
            summary: "transfer",
            verifiability: "partial",
            hyperliquidDeposit: { recipient: getAddress(r.from), dex: r.dex },
          }
        : { verifiability: "opaque", blind: "cctp-destination" },
    ),
  );
  await new Promise((resolve) => {
    setTimeout(resolve, 250);
  });
}

writeFileSync(OUT, `${JSON.stringify({ name: "CCTP Hyperliquid deposits", vectors }, null, 2)}\n`);
console.log(`wrote ${OUT} — ${vectors.length} vectors`);
