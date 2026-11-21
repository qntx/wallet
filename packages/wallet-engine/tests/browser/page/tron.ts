/**
 * The TRON connect browser test page: the official TronLink wallet adapter drives the injected
 * `window.tronLink`/`window.tron`/`window.tronWeb` surface — `adapter.connect()` exercises the
 * TIP-6963 announcement (desktop, with `checkTimeout` falling back to the legacy object) or the
 * immediate `window.tronLink` path (mobile UA), then `signTransaction`/`signMessage`/
 * `signTypedData` go through `tronWeb.trx.sign`/`signMessageV2`/`_signTypedData`.
 */
import { TronLinkAdapter } from "@tronweb3/tronwallet-adapter-tronlink";

type AdapterTx = Parameters<TronLinkAdapter["signTransaction"]>[0];
type AdapterDoc = Parameters<TronLinkAdapter["signTypedData"]>[0];

declare global {
  var tronLink: { ready: boolean; request: (a: unknown) => Promise<unknown>; tronWeb: unknown };
  var tron: { tronWeb: unknown };
  var tronWeb: {
    ready: boolean;
    defaultAddress: unknown;
    request: (a: unknown) => Promise<unknown>;
    trx: {
      sign: (tx: unknown) => Promise<unknown>;
      signMessage: (m: unknown) => Promise<unknown>;
      multiSign: () => Promise<unknown>;
      signMessageV2: (m: unknown) => Promise<unknown>;
      sendRawTransaction: (tx: unknown) => Promise<unknown>;
      getBlockByNumber: (n: unknown) => Promise<unknown>;
    } & Record<string, unknown>;
    transactionBuilder: Record<string, unknown>;
    utils: Record<string, unknown>;
  };
  var tronAdapter: TronLinkAdapter | undefined;
  var tronEvents: unknown[];
  var tronConnect: (checkTimeout?: number) => Promise<unknown>;
  var tronSignTransaction: (transaction: AdapterTx) => Promise<unknown>;
  var tronSignMessage: (message: string) => Promise<unknown>;
  var tronSignTypedData: (doc: AdapterDoc) => Promise<unknown>;
  var tronSendRaw: (transaction: unknown) => Promise<unknown>;
  var tronProbe: () => unknown;
  var tronRefusals: () => Promise<unknown>;
  var tronGenesis: () => Promise<unknown>;
}

globalThis.tronEvents = [];

const adapter = (): TronLinkAdapter => {
  if (globalThis.tronAdapter === undefined) {
    throw new Error("tronConnect has not created an adapter");
  }
  return globalThis.tronAdapter;
};

globalThis.tronConnect = async (checkTimeout = 0): Promise<unknown> => {
  const a = new TronLinkAdapter({ checkTimeout });
  globalThis.tronAdapter = a;
  a.on("accountsChanged", (account: unknown) => {
    globalThis.tronEvents.push({ accountsChanged: account });
  });
  a.on("connect", (address: unknown) => {
    globalThis.tronEvents.push({ connect: address });
  });
  a.on("chainChanged", (data: unknown) => {
    globalThis.tronEvents.push({ chainChanged: data });
  });
  await a.connect();
  return { address: a.address, connected: a.connected };
};

globalThis.tronSignTransaction = async (transaction: AdapterTx): Promise<unknown> =>
  adapter().signTransaction(transaction);

globalThis.tronSignMessage = async (message: string): Promise<unknown> =>
  adapter().signMessage(message);

globalThis.tronSignTypedData = async (doc: AdapterDoc): Promise<unknown> =>
  adapter().signTypedData(doc);

globalThis.tronSendRaw = async (transaction: unknown): Promise<unknown> =>
  globalThis.tronWeb.trx.sendRawTransaction(transaction);

globalThis.tronProbe = (): unknown => {
  const { trx, transactionBuilder: builder, utils } = globalThis.tronWeb;
  return {
    linkReady: globalThis.tronLink.ready,
    webReady: globalThis.tronWeb.ready,
    defaultAddress: globalThis.tronWeb.defaultAddress,
    viaTron: globalThis.tron.tronWeb !== false,
    // Implemented members must be real functions — never the recursive 4200 stub.
    typeofSign: typeof trx.sign,
    typeofSignMessageV2: typeof trx.signMessageV2,
    typeofMultiSign: typeof trx.multiSign,
    typeofSendRaw: typeof trx.sendRawTransaction,
    typeofGetBlock: typeof trx.getBlockByNumber,
    // Stub rules: then/toJSON/symbols/is* resolve to undefined, never a function.
    thenUndef: builder["then"] === undefined,
    toJsonUndef: utils["toJSON"] === undefined,
    isFlagUndef: trx["isConnected"] === undefined,
  };
};

globalThis.tronGenesis = async (): Promise<unknown> => globalThis.tronWeb.trx.getBlockByNumber(0);

const isErrorShape = (v: unknown): v is { code?: unknown; message?: unknown } =>
  typeof v === "object" && v !== null;

const callUnknown = (v: unknown, ...args: unknown[]): unknown =>
  typeof v === "function" ? Reflect.apply(v, undefined, args) : undefined;

const refusal = async (call: () => unknown): Promise<unknown> => {
  try {
    await call();
    return null;
  } catch (error) {
    const e = isErrorShape(error) ? error : {};
    return { code: e.code, message: e.message };
  }
};

globalThis.tronRefusals = async (): Promise<unknown> => ({
  signHex: await refusal(async () => globalThis.tronWeb.trx.sign("deadbeef")),
  multiSign: await refusal(async () => globalThis.tronWeb.trx.multiSign()),
  sendTrx: await refusal(() => callUnknown(globalThis.tronWeb.transactionBuilder["sendTrx"])),
  signMessage: await refusal(async () => globalThis.tronWeb.trx.signMessage("hello")),
  nonZeroBlock: await refusal(async () => globalThis.tronWeb.trx.getBlockByNumber(7)),
  // Unknown members recurse: every level of an unmodeled path still refuses with 4200.
  deep: await refusal(() => {
    const trigger = globalThis.tronWeb.transactionBuilder["triggerSmartContract"];
    // Unknown members are refusal functions; member access on one recurses.
    const nested: unknown =
      typeof trigger === "function" ? Reflect.get(trigger, "anything") : undefined;
    return callUnknown(nested);
  }),
});
