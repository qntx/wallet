/**
 * A `solana-sign` transaction carries the lifetime the dApp chose — the only bytes binding the
 * signature to a cluster — and the wallet never vetted it. `bindDappSolana` runs while the request
 * is still being built, before the prompt and before any kernel sign call: every message's recent
 * blockhash or durable nonce must prove it lives on the session's cluster, corroborated by a second
 * upstream wherever the endpoint list has one.
 */
import { base64 } from "@scure/base";
import { getNonceEncoder, NonceState, SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransactionMessage,
  createTransactionMessage,
  getAddressDecoder,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
} from "@solana/kit";
import type { Instruction, Nonce } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import type { Independent, SolanaRpc } from "../src/networks/controller.ts";
import type { RouteContext } from "../src/transactions/route.ts";
import { bindDappSolana, SolanaClusterBindingError } from "../src/transactions/solana.ts";
import type { SolanaBindingReason } from "../src/transactions/solana.ts";

const NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wjbWdeRjojz";
const filled = (byte: number): string => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
const PAYER = address("4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM");
const RECIPIENT = address("6vN9k1dQ3bBqM2qKf8k8tF4Hh8K5vN9k1dQ3bBqM2qKM");
const NONCE_ACCOUNT = address(filled(7));
const KNOWN_HASH = "11111111111111111111111111111111";
const FOREIGN_HASH = filled(3);
const NONCE_VALUE = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const ADVANCED_VALUE = filled(5);

const transferIx = (): Instruction => ({
  programAddress: SYSTEM_PROGRAM_ADDRESS,
  accounts: [
    { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
    { address: RECIPIENT, role: AccountRole.WRITABLE },
  ],
  // System transfer: instruction index 2, u64 lamports — 1000.
  data: new Uint8Array([2, 0, 0, 0, 0xe8, 3, 0, 0, 0, 0, 0, 0]),
});

const compile = (message: Parameters<typeof compileTransactionMessage>[0]): Uint8Array =>
  new Uint8Array(getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message)));

const blockhashMessage = (hash: string): Uint8Array =>
  compile(
    appendTransactionMessageInstructions(
      [transferIx()],
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash(hash), lastValidBlockHeight: 1000n },
        setTransactionMessageFeePayer(PAYER, createTransactionMessage({ version: 0 })),
      ),
    ),
  );

const durableMessage = (nonce: string): Uint8Array =>
  compile(
    setTransactionMessageLifetimeUsingDurableNonce(
      {
        nonce: nonce as Nonce,
        nonceAccountAddress: NONCE_ACCOUNT,
        nonceAuthorityAddress: PAYER,
      },
      appendTransactionMessageInstructions(
        [transferIx()],
        setTransactionMessageFeePayer(PAYER, createTransactionMessage({ version: 0 })),
      ),
    ),
  );

/** A durable message whose nonce account resolves into the lookup-table space, not static keys. */
const lookupTableDurableMessage = (nonce: string): Uint8Array =>
  new Uint8Array(
    getCompiledTransactionMessageEncoder().encode({
      version: 0,
      header: {
        numSignerAccounts: 1,
        numReadonlySignerAccounts: 0,
        numReadonlyNonSignerAccounts: 1,
      },
      staticAccounts: [PAYER, SYSTEM_PROGRAM_ADDRESS],
      lifetimeToken: blockhash(nonce),
      instructions: [
        {
          programAddressIndex: 1,
          // Index 2 == staticAccounts.length → resolves into the lookup space.
          accountIndices: [2, 0],
          data: new Uint8Array([4, 0, 0, 0]),
        },
      ],
      addressTableLookups: [
        { lookupTableAddress: RECIPIENT, writableIndexes: [0], readonlyIndexes: [] },
      ],
    }),
  );

/** `getNonceEncoder` is the oracle for what the endpoint's base64 account data carries. */
const nonceAccountValue = (value: string): string =>
  base64.encode(
    new Uint8Array(
      getNonceEncoder().encode({
        version: 1,
        state: NonceState.Initialized,
        authority: PAYER,
        blockhash: address(value),
        lamportsPerSignature: 5000n,
      }),
    ),
  );

type Answers = {
  /** `getGenesisHash`; absent answers the configured cluster's. */
  genesis?: string;
  /** `isBlockhashValid`'s value; `"fail"` rejects the call. */
  blockhashValid?: boolean | "fail";
  /** The nonce account: its stored value, a wrong owner, garbage data, or gone (`null`). */
  account?: { value: string } | { owner: string } | { weird: true } | "gone" | "fail";
};

type MockRpc = SolanaRpc & { calls: string[] };

const mockRpc = (answers: Answers = {}): MockRpc => {
  const calls: string[] = [];
  return {
    calls,
    call: async (method) => {
      calls.push(method);
      switch (method) {
        case "getGenesisHash":
          return answers.genesis ?? GENESIS;
        case "isBlockhashValid":
          if (answers.blockhashValid === "fail") {
            return Promise.reject(new TypeError("fetch failed"));
          }
          return { context: { slot: 1 }, value: answers.blockhashValid ?? true };
        case "getAccountInfo": {
          const { account } = answers;
          if (account === "fail") {
            return Promise.reject(new TypeError("fetch failed"));
          }
          if (account === "gone") {
            return { context: { slot: 1 }, value: null };
          }
          if (account !== undefined && "weird" in account) {
            return {
              context: { slot: 1 },
              value: { owner: SYSTEM_PROGRAM_ADDRESS, data: ["AA==", "base64"] },
            };
          }
          if (account !== undefined && "owner" in account) {
            return {
              context: { slot: 1 },
              value: {
                owner: account.owner,
                data: [nonceAccountValue(NONCE_VALUE), "base64"],
              },
            };
          }
          const value = account !== undefined && "value" in account ? account.value : NONCE_VALUE;
          return {
            context: { slot: 1 },
            value: {
              owner: SYSTEM_PROGRAM_ADDRESS,
              data: [nonceAccountValue(value), "base64"],
            },
          };
        }
        default:
          return Promise.reject(new Error(`unmocked ${method}`));
      }
    },
  };
};

const ctx = (
  primary: MockRpc,
  independent: Independent<SolanaRpc>,
  over: { testnet?: boolean; genesis?: string } = {},
): RouteContext =>
  ({
    options: {
      networks: {
        solanaRpc: () => primary,
        independentSolanaRpc: () => independent,
        info: () => ({
          id: NET,
          genesisHash: over.genesis ?? GENESIS,
          testnet: over.testnet ?? false,
        }),
      },
    },
  }) as unknown as RouteContext;

const host = (client: MockRpc): Independent<SolanaRpc> => ({
  kind: "available",
  source: "host",
  client,
});

/**
 * The reason a refused binding call threw — anything but the typed `invalid-request` refusal
 * propagates, so a test that names a reason also proves the error's class and code.
 */
const bindingReason = async (call: Promise<unknown>): Promise<SolanaBindingReason> => {
  const error = await call.then(
    () => {
      throw new Error("the unbound message was not refused");
    },
    (error_: unknown) => error_,
  );
  if (!(error instanceof SolanaClusterBindingError)) {
    throw error;
  }
  if (error.code !== "invalid-request") {
    throw new Error(`unexpected error code ${error.code}`);
  }
  return error.reason;
};

describe("a dApp blockhash binds like a wallet send", () => {
  it("a blockhash the cluster knows binds on the trusted endpoint alone", async () => {
    const primary = mockRpc();
    await expect(
      bindDappSolana(ctx(primary, { kind: "not-needed" }), NET, [blockhashMessage(KNOWN_HASH)]),
    ).resolves.toStrictEqual([]);
    expect(primary.calls).toStrictEqual(["isBlockhashValid"]);
  });

  it("a blockhash the endpoint does not know is refused", async () => {
    const primary = mockRpc({ blockhashValid: false });
    await expect(
      bindingReason(
        bindDappSolana(ctx(primary, { kind: "not-needed" }), NET, [blockhashMessage(FOREIGN_HASH)]),
      ),
    ).resolves.toBe("blockhash-unknown");
  });

  it("a host corroborating the blockhash binds it", async () => {
    const primary = mockRpc();
    const corroborator = mockRpc();
    await expect(
      bindDappSolana(ctx(primary, host(corroborator)), NET, [blockhashMessage(KNOWN_HASH)]),
    ).resolves.toStrictEqual([]);
    expect(corroborator.calls).toStrictEqual(["getGenesisHash", "isBlockhashValid"]);
  });

  it("a host that does not know the blockhash refuses it", async () => {
    await expect(
      bindingReason(
        bindDappSolana(ctx(mockRpc(), host(mockRpc({ blockhashValid: false }))), NET, [
          blockhashMessage(KNOWN_HASH),
        ]),
      ),
    ).resolves.toBe("blockhash-unknown");
  });

  it("a host that cannot answer leaves the message unconfirmed", async () => {
    await expect(
      bindingReason(
        bindDappSolana(ctx(mockRpc(), host(mockRpc({ blockhashValid: "fail" }))), NET, [
          blockhashMessage(KNOWN_HASH),
        ]),
      ),
    ).resolves.toBe("unconfirmed");
  });

  it("a host from another cluster refuses the message", async () => {
    await expect(
      bindingReason(
        bindDappSolana(ctx(mockRpc(), host(mockRpc({ genesis: DEVNET_GENESIS }))), NET, [
          blockhashMessage(KNOWN_HASH),
        ]),
      ),
    ).resolves.toBe("genesis-mismatch");
  });

  it("a primary from another cluster refuses the message", async () => {
    await expect(
      bindingReason(
        bindDappSolana(ctx(mockRpc({ genesis: DEVNET_GENESIS }), host(mockRpc())), NET, [
          blockhashMessage(KNOWN_HASH),
        ]),
      ),
    ).resolves.toBe("genesis-mismatch");
  });

  it("a gateway-only testnet refuses the blockhash outright", async () => {
    await expect(
      bindingReason(
        bindDappSolana(ctx(mockRpc(), { kind: "unavailable" }, { testnet: true }), NET, [
          blockhashMessage(KNOWN_HASH),
        ]),
      ),
    ).resolves.toBe("testnet-gateway-only");
  });

  it("a gateway-only mainnet binds with reads-unverified", async () => {
    const primary = mockRpc();
    await expect(
      bindDappSolana(ctx(primary, { kind: "unavailable" }), NET, [blockhashMessage(KNOWN_HASH)]),
    ).resolves.toStrictEqual(["reads-unverified"]);
    expect(primary.calls).toContain("getGenesisHash");
  });

  it("a gateway-only mainnet on the wrong cluster still refuses", async () => {
    await expect(
      bindingReason(
        bindDappSolana(ctx(mockRpc({ genesis: DEVNET_GENESIS }), { kind: "unavailable" }), NET, [
          blockhashMessage(KNOWN_HASH),
        ]),
      ),
    ).resolves.toBe("genesis-mismatch");
  });
});

describe("a dApp durable nonce binds by reading its account", () => {
  it("a nonce account still holding the value binds on the trusted endpoint alone", async () => {
    const primary = mockRpc({ account: { value: NONCE_VALUE } });
    await expect(
      bindDappSolana(ctx(primary, { kind: "not-needed" }), NET, [durableMessage(NONCE_VALUE)]),
    ).resolves.toStrictEqual([]);
    expect(primary.calls).toStrictEqual(["getAccountInfo"]);
  });

  it("a nonce account that already advanced is refused", async () => {
    await expect(
      bindingReason(
        bindDappSolana(
          ctx(mockRpc({ account: { value: ADVANCED_VALUE } }), { kind: "not-needed" }),
          NET,
          [durableMessage(NONCE_VALUE)],
        ),
      ),
    ).resolves.toBe("nonce-mismatch");
  });

  it("a nonce account that does not exist is refused", async () => {
    await expect(
      bindingReason(
        bindDappSolana(ctx(mockRpc({ account: "gone" }), { kind: "not-needed" }), NET, [
          durableMessage(NONCE_VALUE),
        ]),
      ),
    ).resolves.toBe("nonce-account-missing");
  });

  it("an account that is not a nonce account is refused the same way", async () => {
    await expect(
      bindingReason(
        bindDappSolana(
          ctx(mockRpc({ account: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } }), {
            kind: "not-needed",
          }),
          NET,
          [durableMessage(NONCE_VALUE)],
        ),
      ),
    ).resolves.toBe("nonce-account-missing");
  });

  it("an account with undecodable data is refused the same way", async () => {
    await expect(
      bindingReason(
        bindDappSolana(ctx(mockRpc({ account: { weird: true } }), { kind: "not-needed" }), NET, [
          durableMessage(NONCE_VALUE),
        ]),
      ),
    ).resolves.toBe("nonce-account-missing");
  });

  it("a nonce account resolved through a lookup table is refused without a read", async () => {
    const primary = mockRpc();
    await expect(
      bindingReason(
        bindDappSolana(ctx(primary, { kind: "not-needed" }), NET, [
          lookupTableDurableMessage(NONCE_VALUE),
        ]),
      ),
    ).resolves.toBe("nonce-account-in-lookup-table");
    expect(primary.calls).not.toContain("getAccountInfo");
  });

  it("a host corroborating the nonce value binds it", async () => {
    const corroborator = mockRpc({ account: { value: NONCE_VALUE } });
    await expect(
      bindDappSolana(ctx(mockRpc({ account: { value: NONCE_VALUE } }), host(corroborator)), NET, [
        durableMessage(NONCE_VALUE),
      ]),
    ).resolves.toStrictEqual([]);
    expect(corroborator.calls).toStrictEqual(["getGenesisHash", "getAccountInfo"]);
  });

  it("a host whose nonce already advanced leaves the message unconfirmed", async () => {
    await expect(
      bindingReason(
        bindDappSolana(
          ctx(
            mockRpc({ account: { value: NONCE_VALUE } }),
            host(mockRpc({ account: { value: ADVANCED_VALUE } })),
          ),
          NET,
          [durableMessage(NONCE_VALUE)],
        ),
      ),
    ).resolves.toBe("unconfirmed");
  });

  it("a host that cannot read the account leaves the message unconfirmed", async () => {
    await expect(
      bindingReason(
        bindDappSolana(
          ctx(mockRpc({ account: { value: NONCE_VALUE } }), host(mockRpc({ account: "fail" }))),
          NET,
          [durableMessage(NONCE_VALUE)],
        ),
      ),
    ).resolves.toBe("unconfirmed");
  });

  it("a primary from another cluster refuses the durable message", async () => {
    await expect(
      bindingReason(
        bindDappSolana(
          ctx(
            mockRpc({ genesis: DEVNET_GENESIS, account: { value: NONCE_VALUE } }),
            host(mockRpc({ account: { value: NONCE_VALUE } })),
          ),
          NET,
          [durableMessage(NONCE_VALUE)],
        ),
      ),
    ).resolves.toBe("genesis-mismatch");
  });

  it("a host from another cluster refuses the durable message", async () => {
    await expect(
      bindingReason(
        bindDappSolana(
          ctx(
            mockRpc({ account: { value: NONCE_VALUE } }),
            host(mockRpc({ genesis: DEVNET_GENESIS, account: { value: NONCE_VALUE } })),
          ),
          NET,
          [durableMessage(NONCE_VALUE)],
        ),
      ),
    ).resolves.toBe("genesis-mismatch");
  });

  it("a gateway-only testnet refuses the durable nonce outright", async () => {
    await expect(
      bindingReason(
        bindDappSolana(
          ctx(
            mockRpc({ account: { value: NONCE_VALUE } }),
            { kind: "unavailable" },
            {
              testnet: true,
            },
          ),
          NET,
          [durableMessage(NONCE_VALUE)],
        ),
      ),
    ).resolves.toBe("testnet-gateway-only");
  });

  it("a gateway-only mainnet binds the durable nonce with reads-unverified", async () => {
    await expect(
      bindDappSolana(
        ctx(mockRpc({ account: { value: NONCE_VALUE } }), { kind: "unavailable" }),
        NET,
        [durableMessage(NONCE_VALUE)],
      ),
    ).resolves.toStrictEqual(["reads-unverified"]);
  });

  it("a gateway-only mainnet on the wrong cluster refuses the durable nonce", async () => {
    await expect(
      bindingReason(
        bindDappSolana(
          ctx(mockRpc({ genesis: DEVNET_GENESIS, account: { value: NONCE_VALUE } }), {
            kind: "unavailable",
          }),
          NET,
          [durableMessage(NONCE_VALUE)],
        ),
      ),
    ).resolves.toBe("genesis-mismatch");
  });
});

describe("every message in a batch binds", () => {
  it("a batch whose messages all bind goes through", async () => {
    const primary = mockRpc({ account: { value: NONCE_VALUE } });
    await expect(
      bindDappSolana(ctx(primary, { kind: "not-needed" }), NET, [
        blockhashMessage(KNOWN_HASH),
        durableMessage(NONCE_VALUE),
      ]),
    ).resolves.toStrictEqual([]);
  });

  it("one unbound message in a batch refuses the whole batch", async () => {
    const primary = mockRpc({ blockhashValid: false });
    await expect(
      bindingReason(
        bindDappSolana(ctx(primary, { kind: "not-needed" }), NET, [
          durableMessage(NONCE_VALUE),
          blockhashMessage(FOREIGN_HASH),
        ]),
      ),
    ).resolves.toBe("blockhash-unknown");
  });
});
