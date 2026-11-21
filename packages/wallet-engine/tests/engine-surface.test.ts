import { describe, expectTypeOf, it } from "vite-plus/test";

import type { WalletEngine } from "../src/engine.ts";
import type {
  BitcoinEvent,
  BitcoinRequest,
  BitcoinWalletAccount,
  Eip1193Event,
  Eip1193Request,
  Nip07Request,
  SolanaEvent,
  SolanaRequest,
  SolanaWalletAccount,
  WeblnRequest,
} from "../src/index.ts";
import type { PayInput } from "../src/requests/controller.ts";

/** The request a provider handler takes and the event its `subscribe` listener receives. */
type HandledRequest<H> = H extends { handle: (origin: string, request: infer R) => unknown }
  ? R
  : never;
type ListenedEvent<H> = H extends { subscribe: (listener: (event: infer E) => void) => unknown }
  ? E
  : never;

type Member = keyof WalletEngine;

/** The engine members whose type carries `M` — `never` when no member does. */
type MembersWith<M extends string> = {
  [K in Member]: WalletEngine[K] extends Record<M, unknown> ? K : never;
}[Member];

describe("engine surface", () => {
  it("hands hosts no controller lifecycle or wiring method", () => {
    expectTypeOf<MembersWith<"init">>().toBeNever();
    expectTypeOf<MembersWith<"destroy">>().toBeNever();
    expectTypeOf<MembersWith<"lock">>().toBeNever();
    expectTypeOf<MembersWith<"lockAll">>().toBeNever();
    expectTypeOf<MembersWith<"setStore">>().toBeNever();
    expectTypeOf<MembersWith<"reconcile">>().toBeNever();
    expectTypeOf<MembersWith<"trigger">>().toBeNever();
    expectTypeOf<MembersWith<"invalidateAll">>().toBeNever();
    expectTypeOf<MembersWith<"options">>().toBeNever();
  });

  it("hands hosts only read-only controller stores", () => {
    type Writable = {
      [K in Member]: WalletEngine[K] extends { readonly store: Record<"setState", unknown> }
        ? K
        : never;
    }[Member];
    expectTypeOf<Writable>().toBeNever();
    expectTypeOf<WalletEngine["transactions"]["store"]>().toHaveProperty("subscribe");
    expectTypeOf<WalletEngine["transactions"]["store"]>().toHaveProperty("getState");
  });

  it("engine.spark moves no value — every Spark payment, token sends included, is a request", () => {
    expectTypeOf<WalletEngine["spark"]>().not.toHaveProperty("send");
    expectTypeOf<WalletEngine["spark"]>().not.toHaveProperty("sendToken");
    expectTypeOf<WalletEngine["spark"]>().not.toHaveProperty("payInvoice");
    expectTypeOf<WalletEngine["spark"]>().not.toHaveProperty("paySparkInvoice");
    expectTypeOf<WalletEngine["spark"]>().not.toHaveProperty("withdraw");
    expectTypeOf<WalletEngine["spark"]>().not.toHaveProperty("claimDeposit");
    expectTypeOf<WalletEngine["spark"]>().not.toHaveProperty("setAccounts");
    expectTypeOf<WalletEngine["spark"]>().toHaveProperty("createInvoice");
    expectTypeOf<WalletEngine["spark"]>().toHaveProperty("quoteExit");
    expectTypeOf<WalletEngine["payments"]>().not.toHaveProperty("pay");
    expectTypeOf<WalletEngine["zaps"]>().not.toHaveProperty("pay");
    expectTypeOf<WalletEngine["payments"]>().toHaveProperty("withdrawLnurl");
    expectTypeOf<PayInput>().toHaveProperty("token");
  });

  it("engine.transactions builds and records nothing — sends and dApp signatures are requests", () => {
    expectTypeOf<WalletEngine["transactions"]>().not.toHaveProperty("prepareDapp");
    expectTypeOf<WalletEngine["transactions"]>().not.toHaveProperty("prepareSend");
    expectTypeOf<WalletEngine["transactions"]>().not.toHaveProperty("prepareReplacement");
    expectTypeOf<WalletEngine["transactions"]>().not.toHaveProperty("prepareEvmInternal");
    expectTypeOf<WalletEngine["transactions"]>().not.toHaveProperty("prepareSolanaSwap");
    expectTypeOf<WalletEngine["transactions"]>().not.toHaveProperty("submitDappBitcoin");
    expectTypeOf<WalletEngine["transactions"]>().not.toHaveProperty("submitDappSolana");
    expectTypeOf<WalletEngine["transactions"]>().not.toHaveProperty("recordBatch");
    expectTypeOf<WalletEngine["transactions"]>().not.toHaveProperty("markDepositClaimed");
    expectTypeOf<WalletEngine["transactions"]>().not.toHaveProperty("batchById");
    expectTypeOf<WalletEngine["transactions"]>().toHaveProperty("txById");
    expectTypeOf<WalletEngine["transactions"]>().toHaveProperty("setUtxosFrozen");
    expectTypeOf<WalletEngine["transactions"]>().toHaveProperty("frozenUtxos");
  });

  it("requests are voided by the engine and the connection layer, not by hosts directly", () => {
    expectTypeOf<WalletEngine["requests"]>().not.toHaveProperty("invalidateOrigin");
    expectTypeOf<WalletEngine["requests"]>().toHaveProperty("prepare");
    expectTypeOf<WalletEngine["requests"]>().toHaveProperty("approve");
    expectTypeOf<WalletEngine["requests"]>().toHaveProperty("reject");
    expectTypeOf<WalletEngine["requests"]>().toHaveProperty("outcome");
    expectTypeOf<WalletEngine["connections"]>().toHaveProperty("invalidateOrigin");
    expectTypeOf<WalletEngine["connections"]>().toHaveProperty("checkOrigin");
  });

  it("dApp-side connection steps run only inside the provider handlers", () => {
    expectTypeOf<WalletEngine["connections"]>().not.toHaveProperty("request");
    expectTypeOf<WalletEngine["connections"]>().not.toHaveProperty("authorize");
    expectTypeOf<WalletEngine["connections"]>().not.toHaveProperty("touch");
    expectTypeOf<WalletEngine["connections"]>().toHaveProperty("approveConnection");
  });

  it("metadata merges arrive only through metaSync", () => {
    expectTypeOf<WalletEngine["accounts"]>().not.toHaveProperty("mergeMeta");
    expectTypeOf<WalletEngine["accounts"]>().not.toHaveProperty("exportMeta");
    expectTypeOf<WalletEngine["addressBook"]>().not.toHaveProperty("merge");
    expectTypeOf<WalletEngine["addressBook"]>().not.toHaveProperty("syncEntries");
    expectTypeOf<WalletEngine["metaSync"]>().toHaveProperty("sync");
  });

  it("names every provider handler's request and event at the package root", () => {
    expectTypeOf<HandledRequest<WalletEngine["eip1193"]>>().toEqualTypeOf<Eip1193Request>();
    expectTypeOf<HandledRequest<WalletEngine["nip07"]>>().toEqualTypeOf<Nip07Request>();
    expectTypeOf<HandledRequest<WalletEngine["webln"]>>().toEqualTypeOf<WeblnRequest>();
    expectTypeOf<HandledRequest<WalletEngine["solanaWallet"]>>().toEqualTypeOf<SolanaRequest>();
    expectTypeOf<HandledRequest<WalletEngine["bitcoinWallet"]>>().toEqualTypeOf<BitcoinRequest>();
    expectTypeOf<ListenedEvent<WalletEngine["eip1193"]>>().toEqualTypeOf<Eip1193Event>();
    expectTypeOf<ListenedEvent<WalletEngine["solanaWallet"]>>().toEqualTypeOf<SolanaEvent>();
    expectTypeOf<ListenedEvent<WalletEngine["bitcoinWallet"]>>().toEqualTypeOf<BitcoinEvent>();
    expectTypeOf<SolanaEvent["accounts"][number]>().toEqualTypeOf<SolanaWalletAccount>();
    expectTypeOf<BitcoinEvent["accounts"][number]>().toEqualTypeOf<BitcoinWalletAccount>();
  });
});

describe("host-visible state is deeply read-only", () => {
  // oxlint-disable-next-line vitest/expect-expect -- the assertions are @ts-expect-error type errors
  it("no state object can be assigned or deleted through the facade", () => {
    // Never invoked — the assertions are the @ts-expect-error type errors.
    const edits = (engine: WalletEngine): void => {
      // @ts-expect-error the transactions record is readonly
      engine.transactions.getState().txs = {};
      // @ts-expect-error a tracked row's fields are readonly
      engine.transactions.getState().txs["t"] = undefined;
      // @ts-expect-error deleting through the facade is a type error
      delete engine.transactions.getState().txs["t"];
      // @ts-expect-error the requests record is readonly
      engine.requests.getState().requests["r"] = undefined;
      const { requests } = engine.requests.getState();
      const request = requests["r"]!;
      // @ts-expect-error nested fields are readonly too
      request.stage = "failed";
      // @ts-expect-error the balances record is readonly
      engine.assets.getState().balances["w1"] = undefined;
      // @ts-expect-error address book entries are readonly
      engine.addressBook.getState().entries["a"] = undefined;
      // @ts-expect-error custom RPC lists are readonly
      engine.networks.getState().customRpc["eip155:1"] = [];
      // @ts-expect-error a custom RPC array is a ReadonlyArray — no push
      engine.networks.getState().customRpc["eip155:1"]?.push("http://x");
    };
    void edits;
  });

  // oxlint-disable-next-line vitest/expect-expect -- the assertions are @ts-expect-error type errors
  it("the store's subscribe listener receives the same read-only state", () => {
    const edits = (engine: WalletEngine): void => {
      engine.transactions.store.subscribe((state) => {
        // @ts-expect-error listener state is readonly
        delete state.txs["t"];
      });
      // @ts-expect-error getInitialState is readonly too
      engine.transactions.store.getInitialState().txs = {};
    };
    void edits;
  });
});
