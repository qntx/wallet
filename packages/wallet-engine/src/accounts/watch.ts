import { Address } from "@scure/btc-signer";

import { bitcoinAddressFromXpub } from "@qntx/wallet-chains/bitcoin";
import { checksumEvmAddress, isEvmAddress } from "@qntx/wallet-chains/evm";
import { isSolanaAddress } from "@qntx/wallet-chains/solana";
import { isTronAddress } from "@qntx/wallet-chains/tron";

import { Controller } from "../controller.ts";
import { QR_FINGERPRINT, pathComponents, qrLinkPath } from "../qr/link.ts";
import { readJson } from "../store/json.ts";
import type { EngineCollection, EngineStore } from "../store/port.ts";

/**
 * A watch-only account: an address the wallet tracks but can never sign for. Kept out of
 * `AccountRef` deliberately — a watch account can never reach a signing/request input.
 */
export type WatchAccount = {
  readonly id: string;
  readonly family: "evm" | "solana" | "bitcoin" | "tron";
  readonly address: string;
  readonly name?: string;
  /**
   * The phone this watch account signs through: its master fingerprint, the signing key's path and
   * — Bitcoin only — the account xpub. A qr-linked watch account signs only through the phone's
   * frames; it still never reaches `AccountRef`.
   */
  readonly qr?: { readonly fingerprint: string; readonly path: string; readonly xpub?: string };
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

const BTC_PURPOSE_TEMPLATE: Readonly<
  Record<number, "btc.bip44" | "btc.bip49" | "btc.bip84" | "btc.bip86">
> = { 44: "btc.bip44", 49: "btc.bip49", 84: "btc.bip84", 86: "btc.bip86" };

const normalise = (family: WatchAccount["family"], address: string): string | undefined => {
  if (family === "evm") {
    return isEvmAddress(address) ? checksumEvmAddress(address).toLowerCase() : undefined;
  }
  if (family === "solana") {
    return isSolanaAddress(address) ? address : undefined;
  }
  // TRON base58check is case-sensitive — a valid address is accepted verbatim, never folded.
  if (family === "tron") {
    return isTronAddress(address) ? address : undefined;
  }
  return decodeBtcAddress(address) ? address : undefined;
};

const isQrLink = (v: unknown, family: WatchAccount["family"]): boolean => {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const fingerprint: unknown = Reflect.get(v, "fingerprint");
  const path: unknown = Reflect.get(v, "path");
  const xpub: unknown = Reflect.get(v, "xpub");
  return (
    typeof fingerprint === "string" &&
    QR_FINGERPRINT.test(fingerprint) &&
    typeof path === "string" &&
    qrLinkPath(family, path) &&
    (family === "bitcoin" ? typeof xpub === "string" : xpub === undefined)
  );
};

const isWatchRecord = (v: unknown): v is WatchAccount => {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const family: unknown = Reflect.get(v, "family");
  const name: unknown = Reflect.get(v, "name");
  const qr: unknown = Reflect.get(v, "qr");
  if (family !== "evm" && family !== "solana" && family !== "bitcoin" && family !== "tron") {
    return false;
  }
  return (
    typeof Reflect.get(v, "id") === "string" &&
    typeof Reflect.get(v, "address") === "string" &&
    isNonNegativeInt(Reflect.get(v, "createdAt")) &&
    (name === undefined || typeof name === "string") &&
    (qr === undefined || isQrLink(qr, family))
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
      if (raw === undefined || raw === null) {
        continue;
      }
      const record = readJson(raw);
      if (!isWatchRecord(record)) {
        this.options.logger.warn("dropping a malformed watch account", { record });
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
    readonly qr?: { readonly fingerprint: string; readonly path: string; readonly xpub?: string };
  }): Promise<WatchAccount> {
    const address = normalise(input.family, input.address.trim());
    if (address === undefined) {
      throw new Error(`not a valid ${input.family} address`);
    }
    const { qr } = input;
    if (qr !== undefined) {
      if (!QR_FINGERPRINT.test(qr.fingerprint)) {
        throw new Error("a qr link fingerprint must be 8 lowercase hex digits");
      }
      if (!qrLinkPath(input.family, qr.path)) {
        throw new Error(`path ${qr.path} is not a ${input.family} signing path`);
      }
      if (input.family === "bitcoin" && qr.xpub === undefined) {
        throw new Error("a bitcoin qr link carries the account xpub");
      }
      if (input.family !== "bitcoin" && qr.xpub !== undefined) {
        throw new Error("only a bitcoin qr link carries an xpub");
      }
      if (qr.xpub !== undefined) {
        /* The stored address must be the account's first receive address — the link claims
           exactly one account, and an xpub that derives a different 0/0 is not it. */
        const steps = pathComponents(qr.path);
        const purpose = steps?.[0]?.index;
        const coin = steps?.[1]?.index;
        const template = purpose === undefined ? undefined : BTC_PURPOSE_TEMPLATE[purpose];
        if (template === undefined || (coin !== 0 && coin !== 1)) {
          throw new Error(`bad bitcoin qr path ${qr.path}`);
        }
        const network =
          coin === 0
            ? "bip122:000000000019d6689c085ae165831e93"
            : "bip122:00000000da84f2bafbbc53dee25a72ae";
        if (bitcoinAddressFromXpub(qr.xpub, template, network, 0, 0) !== address) {
          throw new Error("the xpub's first receive address is not the watched address");
        }
      }
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
      ...(qr === undefined ? {} : { qr }),
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
