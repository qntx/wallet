/**
 * `evm-revoke` read-before-build → encode → decode-guard. The scripted transports answer every
 * read; viem's codecs are the independent oracle for the calldata, and `decodeEvm` is the second
 * reader of the built transaction: the revocation must decode back to exactly the requested
 * approvals — nothing out, no authorization, nothing else.
 */
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  erc721Abi,
  isHex,
} from "viem";
import type { Hex, PublicClient } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { ChainError } from "@qntx/wallet-chains";
import type { SignRequest } from "@qntx/wallet-chains";
import {
  checksumEvmAddress,
  decodeBatchExecute,
  decodeEvm,
  encodeBatchExecute,
  PERMIT2_ADDRESS,
} from "@qntx/wallet-chains/evm";

import { guardRevocation, prepareRevokeIntent } from "../src/transactions/evm-revoke.ts";
import { EVM_BATCH_LIMIT } from "../src/transactions/route.ts";
import type { ChainRequestInput } from "../src/transactions/route.ts";

const FROM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const TOKEN = "0x1111111111111111111111111111111111111111";
const NFT = "0x2222222222222222222222222222222222222222";
const SPENDER = "0x3333333333333333333333333333333333333333";
const OPERATOR = "0x4444444444444444444444444444444444444444";
const OTHER = "0x5555555555555555555555555555555555555555";
const ZERO = "0x0000000000000000000000000000000000000000";
const NETWORK = "eip155:1";
const ACCOUNT = {
  kind: "hd" as const,
  walletId: "0a".repeat(8),
  groupIndex: 0,
  template: "evm.bip44" as const,
};

const PERMIT2_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
  {
    type: "function",
    name: "lockdown",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "approvals",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "spender", type: "address" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const ABIS = [...erc20Abi, ...erc721Abi, ...PERMIT2_ABI];

type Call = {
  readonly to: string;
  readonly functionName: string;
  readonly args: ReadonlyArray<unknown>;
};

type Answers = {
  readonly call?: (call: Call) => string | undefined;
  readonly down?: boolean;
};

const client = (answers: Answers): PublicClient =>
  createPublicClient({
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        await Promise.resolve();
        if (answers.down === true) {
          throw new Error("endpoint down");
        }
        if (method !== "eth_call") {
          throw new Error(`unmocked ${method}`);
        }
        const list = Array.isArray(params) ? params : [];
        const [callTx] = list;
        const isObj = (v: unknown): v is Record<string, unknown> =>
          typeof v === "object" && v !== null;
        const to = isObj(callTx) && typeof callTx["to"] === "string" ? callTx["to"] : "";
        const data = isObj(callTx) && isHex(callTx["data"]) ? callTx["data"] : "0x";
        const decoded = decodeFunctionData({ abi: ABIS, data });
        const out = answers.call?.({
          to,
          functionName: decoded.functionName,
          args: decoded.args,
        });
        if (out === undefined) {
          throw new Error(`unmocked call ${decoded.functionName} on ${to}`);
        }
        return out;
      },
    }),
  });

const uint = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`;
const addr = (value: string): Hex => `0x${value.slice(2).padStart(64, "0")}`;

/* The four live-state scripts — one per target kind. */
const erc20Live = (allowance: bigint) => (call: Call) =>
  call.functionName === "allowance" ? uint(allowance) : undefined;

const permit2Live = (amount: bigint) => (call: Call) =>
  call.functionName === "allowance"
    ? encodeFunctionResult({
        abi: PERMIT2_ABI,
        functionName: "allowance",
        result: [amount, 0, 0],
      })
    : undefined;

const operatorLive = (approved: boolean) => (call: Call) =>
  call.functionName === "isApprovedForAll" ? uint(BigInt(approved)) : undefined;

const nftLive = (approved: string, owner: string) => (call: Call) => {
  if (call.functionName === "getApproved") {
    return addr(approved);
  }
  if (call.functionName === "ownerOf") {
    return addr(owner);
  }
  return undefined;
};

type Delegation =
  | { readonly kind: "none" }
  | { readonly kind: "ours" }
  | { readonly kind: "other"; readonly address: string };

/** `nftRead`'s rule: a disagreeing successful read refuses, a failed one flags the request. */
const rig = (options: {
  readonly primary: Answers;
  readonly independent?: Answers | "unavailable";
  readonly delegation?: Delegation;
  readonly flags?: Array<string | undefined>;
}) => ({
  crossRead: async <T>(read: (client: PublicClient) => Promise<T>): Promise<T> => {
    const primary = await read(client(options.primary));
    if (options.independent !== undefined && options.independent !== "unavailable") {
      try {
        const other = await read(client(options.independent));
        if (other !== primary) {
          throw new ChainError("invalid-request", "the two endpoints disagree on the read");
        }
      } catch (error) {
        if (error instanceof ChainError) {
          throw error;
        }
        options.flags?.push("reads-unverified");
      }
    }
    return primary;
  },
  delegationState: async (): Promise<Delegation> =>
    Promise.resolve(options.delegation ?? { kind: "none" }),
});

const revokeInput = (
  targets: Extract<ChainRequestInput, { method: "evm-revoke" }>["targets"],
): Extract<ChainRequestInput, { method: "evm-revoke" }> => ({
  method: "evm-revoke",
  account: ACCOUNT,
  network: NETWORK,
  targets,
  fee: "normal",
});

/** Narrows a built intent to the call — the builder only produces call intents. */
const callOf = (intent: Awaited<ReturnType<typeof prepareRevokeIntent>>) => {
  const call = intent.kind === "call" ? intent : undefined;
  if (call === undefined) {
    throw new Error("expected a call intent");
  }
  return call;
};

const requestOf = (to: string, data: string): SignRequest => ({
  kind: "evm.transaction",
  network: NETWORK,
  account: ACCOUNT,
  tx: {
    type: "eip1559",
    chainId: 1,
    to,
    value: "0x0",
    nonce: 0,
    gas: "0x0",
    data,
    accessList: [],
    maxFeePerGas: "0x0",
    maxPriorityFeePerGas: "0x0",
  },
});

describe("evm-revoke calldata", () => {
  it("encodes approve(spender, 0) on the token for an erc20 row", async () => {
    const intent = await prepareRevokeIntent(
      revokeInput([{ kind: "erc20", token: TOKEN, spender: SPENDER }]),
      FROM,
      rig({ primary: { call: erc20Live(7n) } }),
    );
    expect(intent).toMatchObject({ kind: "call", to: checksumEvmAddress(TOKEN), value: 0n });
    const { data } = callOf(intent);
    expect(data).toBe(
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [SPENDER, 0n],
      }),
    );
    /* decodeEvm is the second reader — it must name exactly this revocation. */
    const decoded = decodeEvm(requestOf(callOf(intent).to, data), FROM);
    expect(decoded.approvals).toStrictEqual([
      {
        kind: "allowance",
        spender: checksumEvmAddress(SPENDER),
        amount: { asset: checksumEvmAddress(TOKEN), amount: "0" },
        change: "set",
        unlimited: false,
        verified: false,
      },
    ]);
    expect(decoded.outflows).toStrictEqual([]);
  });

  it("encodes lockdown([{token, spender}]) on Permit2", async () => {
    const intent = await prepareRevokeIntent(
      revokeInput([{ kind: "permit2", token: TOKEN, spender: SPENDER }]),
      FROM,
      rig({ primary: { call: permit2Live(9n) } }),
    );
    expect(intent).toMatchObject({ kind: "call", to: PERMIT2_ADDRESS, value: 0n });
    const { data } = callOf(intent);
    expect(data).toBe(
      encodeFunctionData({
        abi: PERMIT2_ABI,
        functionName: "lockdown",
        args: [[{ token: TOKEN, spender: SPENDER }]],
      }),
    );
    const decoded = decodeEvm(requestOf(PERMIT2_ADDRESS, data), FROM);
    expect(decoded.approvals).toStrictEqual([
      {
        kind: "allowance",
        spender: checksumEvmAddress(SPENDER),
        amount: { asset: checksumEvmAddress(TOKEN), amount: "0" },
        change: "set",
        unlimited: false,
        via: "permit2",
        verified: false,
      },
    ]);
  });

  it("encodes setApprovalForAll(operator, false) on the contract", async () => {
    const intent = await prepareRevokeIntent(
      revokeInput([{ kind: "operator", contract: NFT, operator: OPERATOR }]),
      FROM,
      rig({ primary: { call: operatorLive(true) } }),
    );
    const { data } = callOf(intent);
    expect(intent).toMatchObject({ to: checksumEvmAddress(NFT) });
    expect(data).toBe(
      encodeFunctionData({
        abi: erc721Abi,
        functionName: "setApprovalForAll",
        args: [OPERATOR, false],
      }),
    );
    const decoded = decodeEvm(requestOf(NFT, data), FROM);
    expect(decoded.approvals).toStrictEqual([
      {
        kind: "operator",
        asset: checksumEvmAddress(NFT),
        spender: checksumEvmAddress(OPERATOR),
        approved: false,
        verified: false,
      },
    ]);
  });

  it("encodes approve(0, tokenId) on the NFT contract — an approval clear, not a grant", async () => {
    const intent = await prepareRevokeIntent(
      revokeInput([{ kind: "nft", contract: NFT, tokenId: 42n }]),
      FROM,
      rig({ primary: { call: nftLive(SPENDER, FROM) } }),
    );
    const { data } = callOf(intent);
    expect(data).toBe(
      encodeFunctionData({ abi: erc721Abi, functionName: "approve", args: [ZERO, 42n] }),
    );
    const decoded = decodeEvm(requestOf(NFT, data), FROM);
    /* A cleared approval must never read as authority granted to the zero address. */
    expect(decoded.approvals).toStrictEqual([
      { kind: "approval-cleared", asset: checksumEvmAddress(NFT), value: "42", verified: false },
    ]);
  });
});

describe("evm-revoke read-before-build", () => {
  it("refuses a zero erc20 allowance", async () => {
    await expect(
      prepareRevokeIntent(
        revokeInput([{ kind: "erc20", token: TOKEN, spender: SPENDER }]),
        FROM,
        rig({ primary: { call: erc20Live(0n) } }),
      ),
    ).rejects.toThrow(/nothing to revoke/);
  });

  it("refuses a zero Permit2 amount", async () => {
    await expect(
      prepareRevokeIntent(
        revokeInput([{ kind: "permit2", token: TOKEN, spender: SPENDER }]),
        FROM,
        rig({ primary: { call: permit2Live(0n) } }),
      ),
    ).rejects.toThrow(/nothing to revoke/);
  });

  it("refuses an operator that is not approved", async () => {
    await expect(
      prepareRevokeIntent(
        revokeInput([{ kind: "operator", contract: NFT, operator: OPERATOR }]),
        FROM,
        rig({ primary: { call: operatorLive(false) } }),
      ),
    ).rejects.toThrow(/nothing to revoke/);
  });

  it("refuses an NFT with no approved spender", async () => {
    await expect(
      prepareRevokeIntent(
        revokeInput([{ kind: "nft", contract: NFT, tokenId: 1n }]),
        FROM,
        rig({ primary: { call: nftLive(ZERO, FROM) } }),
      ),
    ).rejects.toThrow(/nothing to revoke/);
  });

  it("refuses an NFT the signer no longer owns", async () => {
    await expect(
      prepareRevokeIntent(
        revokeInput([{ kind: "nft", contract: NFT, tokenId: 1n }]),
        FROM,
        rig({ primary: { call: nftLive(SPENDER, OTHER) } }),
      ),
    ).rejects.toThrow(/nothing to revoke/);
  });

  it("refuses when the two endpoints disagree on the live state", async () => {
    await expect(
      prepareRevokeIntent(
        revokeInput([{ kind: "erc20", token: TOKEN, spender: SPENDER }]),
        FROM,
        rig({
          primary: { call: erc20Live(7n) },
          independent: { call: erc20Live(8n) },
        }),
      ),
    ).rejects.toThrow(/the two endpoints disagree/);
  });

  it("a failed independent read flags reads-unverified but still prepares", async () => {
    const flags: Array<string | undefined> = [];
    const intent = await prepareRevokeIntent(
      revokeInput([{ kind: "erc20", token: TOKEN, spender: SPENDER }]),
      FROM,
      rig({
        primary: { call: erc20Live(7n) },
        independent: { down: true },
        flags,
      }),
    );
    expect(intent.kind).toBe("call");
    expect(flags).toContain("reads-unverified");
  });

  it("an expired-but-nonzero Permit2 allowance is still revocable — lockdown zeroes it", async () => {
    const intent = await prepareRevokeIntent(
      revokeInput([{ kind: "permit2", token: TOKEN, spender: SPENDER }]),
      FROM,
      rig({ primary: { call: permit2Live(1n) } }),
    );
    expect(intent).toMatchObject({ to: PERMIT2_ADDRESS });
  });
});

const two = [
  { kind: "erc20" as const, token: TOKEN, spender: SPENDER },
  { kind: "operator" as const, contract: NFT, operator: OPERATOR },
];
const twoLive = (call: Call): string | undefined =>
  call.to.toLowerCase() === NFT.toLowerCase() ? operatorLive(true)(call) : erc20Live(7n)(call);

describe("evm-revoke batch", () => {
  it("two targets with the wallet's delegation build one self-call batch without authorization", async () => {
    const intent = await prepareRevokeIntent(
      revokeInput(two),
      FROM,
      rig({ primary: { call: twoLive }, delegation: { kind: "ours" } }),
    );
    expect(intent).toMatchObject({ kind: "call", to: FROM, value: 0n });
    expect(callOf(intent).authorization).toBeUndefined();
    const calls = decodeBatchExecute(callOf(intent).data);
    expect(calls).toHaveLength(2);
    expect(calls?.[0]?.to).toBe(checksumEvmAddress(TOKEN));
    expect(calls?.[1]?.to).toBe(checksumEvmAddress(NFT));
    expect(calls?.[0]?.data).toBe(
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SPENDER, 0n] }),
    );
    expect(calls?.[1]?.data).toBe(
      encodeFunctionData({
        abi: erc721Abi,
        functionName: "setApprovalForAll",
        args: [OPERATOR, false],
      }),
    );
    /* The batch decodes to exactly the two revocations. */
    const decoded = decodeEvm(requestOf(FROM, callOf(intent).data), FROM);
    expect(decoded.summary).toBe("batch");
    expect(decoded.approvals?.map((a) => a.kind)).toStrictEqual(["allowance", "operator"]);
    expect(decoded.outflows).toStrictEqual([]);
  });

  it("refuses a batch without delegation — revoke one by one", async () => {
    await expect(
      prepareRevokeIntent(revokeInput(two), FROM, rig({ primary: { call: twoLive } })),
    ).rejects.toThrow(/delegated to the wallet's delegator/);
  });

  it("refuses a batch while delegated elsewhere", async () => {
    await expect(
      prepareRevokeIntent(
        revokeInput(two),
        FROM,
        rig({ primary: { call: twoLive }, delegation: { kind: "other", address: OTHER } }),
      ),
    ).rejects.toThrow(/delegated to the wallet's delegator/);
  });

  it("refuses duplicate targets", async () => {
    await expect(
      prepareRevokeIntent(
        revokeInput([
          { kind: "erc20", token: TOKEN, spender: SPENDER },
          { kind: "erc20", token: TOKEN, spender: SPENDER },
        ]),
        FROM,
        rig({ primary: { call: erc20Live(1n) } }),
      ),
    ).rejects.toThrow(/duplicate revoke target/);
  });

  it("refuses more than EVM_BATCH_LIMIT targets", async () => {
    const many = Array.from({ length: EVM_BATCH_LIMIT + 1 }, (_, i) => ({
      kind: "erc20" as const,
      token: `0x${String(i + 16).padStart(40, "0")}`,
      spender: SPENDER,
    }));
    await expect(
      prepareRevokeIntent(revokeInput(many), FROM, rig({ primary: { call: erc20Live(1n) } })),
    ).rejects.toThrow(/takes 1\.\.\d+ targets/);
  });

  it("refuses a malformed address", async () => {
    await expect(
      prepareRevokeIntent(
        revokeInput([{ kind: "erc20", token: "not-an-address", spender: SPENDER }]),
        FROM,
        rig({ primary: { call: erc20Live(1n) } }),
      ),
    ).rejects.toThrow(/malformed address/);
  });

  it("an erc20 target on the zero address refuses — its build decodes as a clear, not a revoke", async () => {
    /* The chain says the zero spender holds an allowance (read-before-build passes), but
       approve(0x0, 0) decodes as `approval-cleared` — the guard's expected shape fails. */
    await expect(
      prepareRevokeIntent(
        revokeInput([{ kind: "erc20", token: TOKEN, spender: ZERO }]),
        FROM,
        rig({ primary: { call: erc20Live(7n) } }),
      ),
    ).rejects.toThrow(/does not decode/);
  });
});

describe("evm-revoke decode guard", () => {
  const single = revokeInput([{ kind: "erc20", token: TOKEN, spender: SPENDER }]);

  it("a build whose calldata grants instead of revoking is refused", () => {
    expect(() =>
      guardRevocation(single, FROM, {
        kind: "call",
        to: checksumEvmAddress(TOKEN),
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [SPENDER, 5n],
        }),
      }),
    ).toThrow(/does not decode/);
  });

  it("a build carrying an outflow alongside the revocation is refused", () => {
    expect(() =>
      guardRevocation(single, FROM, {
        kind: "call",
        to: checksumEvmAddress(TOKEN),
        value: 1n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [SPENDER, 0n],
        }),
      }),
    ).toThrow(/does not decode/);
  });

  it("a batch build whose calls add an unrelated transfer is refused", () => {
    expect(() =>
      guardRevocation(revokeInput(two), FROM, {
        kind: "call",
        to: FROM,
        value: 0n,
        data: encodeBatchExecute([
          {
            to: TOKEN,
            value: 0n,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [SPENDER, 0n],
            }),
          },
          { to: OTHER, value: 1n, data: "0x" },
        ]),
      }),
    ).toThrow(/does not decode/);
  });
});
