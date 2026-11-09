import { Address } from "@scure/btc-signer";

import { checksumEvmAddress, isEvmAddress } from "@qntx/wallet-chains/evm";
import { isSolanaAddress } from "@qntx/wallet-chains/solana";

import { Controller } from "../controller.ts";
import type { EngineCollection, EngineStore } from "../store/port.ts";

/**
 * A watch-only account: an address the wallet tracks but can never sign for. Kept out of
 * `AccountRef` deliberately — a watch account can never reach a signing/request input.
 */
export type WatchAccount = {
  readonly id: string;
  readonly family: "evm" | "solana" | "bitcoin";
  readonly address: string;
  readonly name?: string;
  readonly createdAt: number;
};

export type WatchState = {
  readonly accounts: Readonly<Record<string, WatchAccount>>;
};

export type WatchControllerOptions = {
  readonly random: (n: number) => Uint8Array;
  readonly now: () => number;
  readonly logger: {
    readonly warn: (msg: string, meta?: unknown) => void;
  };
  /** Every address the wallet already owns — any HD-derived or already-known address. */
  readonly ownAddresses: () => Promise<ReadonlyArray<string>>;
};

const isNonNegativeInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

const decodeBtcAddress = (address: string): boolean => {
  try {
    Address().decode(address);
    return true;
  } catch {
    return false;
  }
};

const normalise = (family: WatchAccount["family"], address: string): string | undefined => {
  if (family === "evm") {
    return isEvmAddress(address) ? checksumEvmAddress(address).toLowerCase() : undefined;
  }
  if (family === "solana") {
    return isSolanaAddress(address) ? address : undefined;
  }
  return decodeBtcAddress(address) ? address : undefined;
};

const isWatchRecord = (v: unknown): v is WatchAccount => {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const family: unknown = Reflect.get(v, "family");
  const name: unknown = Reflect.get(v, "name");
  return (
    typeof Reflect.get(v, "id") === "string" &&
    (family === "evm" || family === "solana" || family === "bitcoin") &&
    typeof Reflect.get(v, "address") === "string" &&
    isNonNegativeInt(Reflect.get(v, "createdAt")) &&
    (name === undefined || typeof name === "string")
  );
};

const hexId = (random: (n: number) => Uint8Array): string =>
  Array.from(random(16), (b) => b.toString(16).padStart(2, "0")).join("");

export class WatchController extends Controller<WatchState> {
  private col: EngineCollection | undefined;
  private readonly options: WatchControllerOptions;

  constructor(options: WatchControllerOptions) {
    super({ name: "watch", defaultState: () => ({ accounts: {} }) });
    this.options = options;
  }

  setStore(store: EngineStore | undefined): void {
    this.col = store?.collection("watch");
  }

  async init(): Promise<void> {
    if (this.col === undefined) {
      return;
    }
    const keys = await this.col.list();
    const rows = await Promise.all(keys.map(async (key) => this.col?.get(key)));
    const accounts: Record<string, WatchAccount> = {};
    for (const raw of rows) {
      const record =
        raw === undefined || raw === null
          ? undefined
          : (JSON.parse(new TextDecoder().decode(raw)) as unknown);
      if (!isWatchRecord(record)) {
        if (record !== undefined) {
          this.options.logger.warn("dropping a malformed watch account", { record });
        }
        continue;
      }
      accounts[record.id] = record;
    }
    this.update(() => ({ accounts }));
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  lock(): void {
    this.col = undefined;
    this.update(() => ({ accounts: {} }));
  }

  private async persist(account: WatchAccount): Promise<void> {
    await this.col?.put(`watch/${account.id}`, new TextEncoder().encode(JSON.stringify(account)));
  }

  async add(input: {
    readonly family: WatchAccount["family"];
    readonly address: string;
    readonly name?: string;
  }): Promise<WatchAccount> {
    const address = normalise(input.family, input.address.trim());
    if (address === undefined) {
      throw new Error(`not a valid ${input.family} address`);
    }
    if (Object.values(this.getState().accounts).some((a) => a.address === address)) {
      throw new Error("the address is already watched");
    }
    const own = await this.options.ownAddresses();
    if (own.some((a) => a.toLowerCase() === address.toLowerCase())) {
      throw new Error("the address is one of the wallet's own accounts");
    }
    const account: WatchAccount = {
      id: hexId(this.options.random),
      family: input.family,
      address,
      createdAt: this.options.now(),
      ...(input.name === undefined ? {} : { name: input.name }),
    };
    this.update((s) => ({ accounts: { ...s.accounts, [account.id]: account } }));
    await this.persist(account);
    return account;
  }

  async rename(id: string, name: string): Promise<void> {
    const account = this.getState().accounts[id];
    if (account === undefined) {
      throw new Error("no such watch account");
    }
    const next = { ...account, name };
    this.update((s) => ({ accounts: { ...s.accounts, [id]: next } }));
    await this.persist(next);
  }

  async remove(id: string): Promise<void> {
    const account = this.getState().accounts[id];
    if (account === undefined) {
      throw new Error("no such watch account");
    }
    this.update((s) => ({
      accounts: Object.fromEntries(Object.entries(s.accounts).filter(([key]) => key !== id)),
    }));
    await this.col?.delete(`watch/${id}`);
  }

  list(): ReadonlyArray<WatchAccount> {
    return Object.values(this.getState().accounts).sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
  }
}
