/**
 * The decode-assert tail of every TRON request (`finishTron`): the locally built `raw_data` must
 * decode back to exactly the operation the user asked for — a decoder that disagrees refuses the
 * request before any signing or broadcast, so a build/decode skew can never sign the wrong bytes.
 * `decodeTron` is mocked once to prove the refusal path itself runs.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it, vi } from "vite-plus/test";

import { tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";
import type { decodeTron } from "@qntx/wallet-chains/tron";

import type { TronApi } from "../src/chains/tron.ts";
import type { AccountRef, PrepareParams, RouteContext } from "../src/transactions/route.ts";
import { prepareTron } from "../src/transactions/tron.ts";

vi.mock("@qntx/wallet-chains/tron", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const decode = original["decodeTron"] as typeof decodeTron;
  return {
    ...original,
    // The decoder reports a transfer that carries nothing — no honest build can produce this.
    decodeTron: (
      request: Parameters<typeof decodeTron>[0],
      signer: string,
    ): ReturnType<typeof decodeTron> => ({
      ...decode(request, signer),
      outflows: [],
    }),
  };
});

const NET = "tron:3448148188";
const FROM = tronAddressFromPublicKey(secp256k1.getPublicKey(new Uint8Array(32).fill(0x11), false));
const TO = tronAddressFromPublicKey(secp256k1.getPublicKey(new Uint8Array(32).fill(0x22), false));
const ACCOUNT: AccountRef = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "tron.bip44",
};
const PARAMS = [
  { key: "getTransactionFee", value: 1000 },
  { key: "getEnergyFee", value: 210 },
  { key: "getCreateAccountFee", value: 100_000 },
  { key: "getCreateNewAccountFeeInSystemContract", value: 1_000_000 },
  { key: "getMaxFeeLimit", value: 5_000_000_000 },
  { key: "getCreateNewAccountBandwidthRate", value: 4 },
  { key: "getMaxCreateAccountTxSize", value: 5000 },
];

const api: TronApi = {
  post: async (path, body) => {
    const b = body as Record<string, unknown>;
    switch (path) {
      case "/walletsolidity/getnowblock":
        return Promise.resolve({
          blockID: "ab".repeat(32),
          block_header: { raw_data: { number: 100, timestamp: 900_000 } },
        });
      case "/wallet/getchainparameters":
        return Promise.resolve({ chainParameter: PARAMS });
      case "/wallet/getaccount":
        return Promise.resolve({ address: b["address"], balance: 100_000_000 });
      case "/wallet/getaccountresource":
        return Promise.resolve({ freeNetLimit: 600 });
      default:
        return Promise.reject(new Error(`unmocked ${path}`));
    }
  },
};

const ctx: RouteContext = {
  options: {
    networks: {
      tronApi: () => api,
      independentTronApi: () => ({ kind: "not-needed" }),
    } as never,
    wallet: {} as never,
    openStore: async () => Promise.resolve({} as never),
    random: (n: number) => new Uint8Array(n),
    setTimer: () => () => {},
    now: () => 1_000_000,
    logger: { warn: () => {} },
    chains: {
      account: async () => Promise.resolve({ template: "tron.bip44", network: NET, address: FROM }),
      sign: async () => Promise.reject(new Error("signing is behind the decode assertion")),
    } as never,
  },
  transition: async (tx, next) => Promise.resolve({ ...tx, ...next }),
  track: () => {},
  txs: () => ({}),
  newId: () => "tx-test",
};

const params = (): PrepareParams => ({
  account: ACCOUNT,
  network: NET,
  to: TO,
  amount: 1_000_000n,
  fee: "normal",
});

describe("finishTron decode assertion", () => {
  it("refuses when the built bytes do not decode to the requested send", async () => {
    await expect(prepareTron(ctx, params())).rejects.toThrow(
      "does not decode to the requested transfer",
    );
  });
});
