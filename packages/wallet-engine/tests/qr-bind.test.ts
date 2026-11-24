import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { NETWORK, Transaction } from "@scure/btc-signer";
import { p2ms, p2sh, p2tr, p2wpkh, p2wsh, tapLeafHash } from "@scure/btc-signer/payment.js";
import {
  address,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
} from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import type { QrAccountFacts } from "../src/qr/bind.ts";
import { bindQrRequest } from "../src/qr/bind.ts";
import { QrError } from "../src/qr/errors.ts";
import { BITCOIN_MAINNET } from "../src/qr/link.ts";
import type { QrRequest } from "../src/qr/request.ts";

const H = 0x80000000;
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
const XFP = master.fingerprint;

const EVM_ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const TRON_ADDR = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const SOLANA_ADDR = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TRON_MAINNET = "tron:728126428";
const SEPOLIA = "eip155:11155111";
const TESTNET4 = "bip122:000000000933ea01ad0ee984209779ba";

const EVM_PATH = [44 + H, 60 + H, H, 0, 0];
const TRON_PATH = [44 + H, 195 + H, H, 0, 0];
const SOLANA_PATH = [44 + H, 501 + H, H, H];
const BTC84_PATH = [84 + H, H, H, 0, 0];

const FACTS: QrAccountFacts = {
  walletId: "w",
  groupIndex: 0,
  fingerprint: XFP,
  addresses: { evm: EVM_ADDR, tron: TRON_ADDR, solana: SOLANA_ADDR },
  networks: {
    evm: [SEPOLIA],
    solana: [SOLANA_MAINNET],
    tron: [TRON_MAINNET],
    bitcoin: [BITCOIN_MAINNET],
  },
};

const EVM_TX = {
  type: "eip1559" as const,
  chainId: 11155111,
  nonce: 0,
  gas: "0x5208",
  to: "0x00000000000000000000000000000000deadbeef",
  value: "0x1",
  data: "0x",
  accessList: [],
  maxFeePerGas: "0x1",
  maxPriorityFeePerGas: "0x1",
};

const evmTx = (
  over: Partial<Extract<QrRequest, { family: "evm"; kind: "transaction" }>> = {},
): QrRequest => ({
  family: "evm",
  kind: "transaction",
  path: EVM_PATH,
  xfp: XFP,
  declared: "qr.test",
  tx: EVM_TX,
  data: new Uint8Array(0),
  ...over,
});

const solanaMessageBytes = (payer: string): Uint8Array =>
  new Uint8Array(
    getCompiledTransactionMessageEncoder().encode(
      compileTransactionMessage(
        setTransactionMessageFeePayer(address(payer), createTransactionMessage({ version: 0 })),
      ),
    ),
  );

const solanaRequest = (
  kind: "transaction" | "message",
  data: Uint8Array,
  over: Partial<Extract<QrRequest, { family: "solana" }>> = {},
): QrRequest => ({
  family: "solana",
  kind,
  path: SOLANA_PATH,
  xfp: XFP,
  address: SOLANA_ADDR,
  data,
  ...over,
});

const tronRequest = (
  kind: "transaction" | "message",
  over: Partial<Extract<QrRequest, { family: "tron" }>> = {},
): QrRequest => ({
  family: "tron",
  kind,
  path: TRON_PATH,
  xfp: XFP,
  address: TRON_ADDR,
  data: new Uint8Array(32).fill(1),
  ...over,
});

const pubkeyAt = (path: string): Uint8Array => {
  const pub = master.derive(path).publicKey;
  if (pub === null) {
    throw new Error("no public key");
  }
  return pub;
};

/** A QR PSBT: inputs already carry their bip32 derivation — what a watch-only wallet broadcasts. */
const qrPsbt = (input: {
  readonly script?: Uint8Array;
  readonly path?: ReadonlyArray<number>;
  readonly fingerprint?: number;
  readonly tap?: boolean;
  readonly leafHashes?: ReadonlyArray<Uint8Array>;
  readonly sighashType?: number;
  readonly witnessScript?: Uint8Array;
  readonly redeemScript?: Uint8Array;
}): Uint8Array => {
  const tx = new Transaction({ version: 2 });
  const key =
    input.tap === true ? pubkeyAt("m/86'/0'/0'/0/0").slice(1) : pubkeyAt("m/84'/0'/0'/0/0");
  const leafKey = pubkeyAt("m/86'/0'/0'/0/1").slice(1);
  const leaf =
    input.leafHashes === undefined ? undefined : new Uint8Array([0x20, ...leafKey, 0xac]);
  const tree = leaf === undefined ? undefined : p2tr(key, [{ script: leaf }], NETWORK);
  const script =
    input.script ??
    tree?.script ??
    (input.tap === true ? p2tr(key, undefined, NETWORK).script : p2wpkh(key, NETWORK).script);
  tx.addInput({
    txid: new Uint8Array(32).fill(7),
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script, amount: 100_000n },
    ...(input.sighashType === undefined ? {} : { sighashType: input.sighashType }),
    ...(input.witnessScript === undefined ? {} : { witnessScript: input.witnessScript }),
    ...(input.redeemScript === undefined ? {} : { redeemScript: input.redeemScript }),
    ...(tree === undefined
      ? {}
      : {
          tapInternalKey: tree.tapInternalKey,
          tapMerkleRoot: tree.tapMerkleRoot,
          tapLeafScript: (tree.tapLeafScript ?? []).map(([control, leaf]) => [control, leaf]),
        }),
  });
  if (input.path !== undefined) {
    const fingerprint = input.fingerprint ?? XFP;
    tx.updateInput(
      0,
      input.tap === true
        ? {
            tapBip32Derivation: [
              [
                key,
                {
                  hashes: leaf === undefined ? [] : [tapLeafHash(leaf, 0xc0)],
                  der: { fingerprint, path: [...input.path] },
                },
              ],
            ],
          }
        : { bip32Derivation: [[key, { fingerprint, path: [...input.path] }]] },
    );
  }
  tx.addOutput({ script: p2wpkh(pubkeyAt("m/84'/0'/9'/0/0"), NETWORK).script, amount: 90_000n });
  return tx.toPSBT(0);
};

/** A p2wpkh PSBT with several inputs — one derivation path each — for the cross-input rules. */
const qrPsbtMulti = (
  inputs: ReadonlyArray<{ readonly path: ReadonlyArray<number>; readonly fingerprint?: number }>,
): Uint8Array => {
  const tx = new Transaction({ version: 2 });
  const key = pubkeyAt("m/84'/0'/0'/0/0");
  for (const input of inputs) {
    tx.addInput({
      txid: new Uint8Array(32).fill(7),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: p2wpkh(key, NETWORK).script, amount: 100_000n },
    });
    tx.updateInput(tx.inputsLength - 1, {
      bip32Derivation: [[key, { fingerprint: input.fingerprint ?? XFP, path: [...input.path] }]],
    });
  }
  tx.addOutput({ script: p2wpkh(pubkeyAt("m/84'/0'/9'/0/0"), NETWORK).script, amount: 90_000n });
  return tx.toPSBT(0);
};

const bitcoinRequest = (psbt: Uint8Array): QrRequest => ({
  family: "bitcoin",
  kind: "psbt",
  urType: "crypto-psbt",
  psbt,
});

const solanaSend = (input: unknown): boolean | undefined =>
  typeof input === "object" &&
  input !== null &&
  "request" in input &&
  typeof input.request === "object" &&
  input.request !== null &&
  "kind" in input.request &&
  input.request.kind === "transactions" &&
  "send" in input.request
    ? Boolean(input.request.send)
    : undefined;

const psbtSend = (input: unknown): boolean | undefined =>
  typeof input === "object" &&
  input !== null &&
  "request" in input &&
  typeof input.request === "object" &&
  input.request !== null &&
  "kind" in input.request &&
  input.request.kind === "psbt" &&
  "send" in input.request
    ? Boolean(input.request.send)
    : undefined;

const psbtSigns = (
  input: unknown,
): ReadonlyArray<{ index: number; sigHash: string; template: string }> | undefined =>
  typeof input === "object" &&
  input !== null &&
  "request" in input &&
  typeof input.request === "object" &&
  input.request !== null &&
  "kind" in input.request &&
  input.request.kind === "psbt" &&
  "psbts" in input.request &&
  Array.isArray(input.request.psbts)
    ? (input.request.psbts[0]?.sign as ReadonlyArray<{
        index: number;
        sigHash: string;
        template: string;
      }>)
    : undefined;

const code = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof QrError ? error.code : `unexpected:${String(error)}`;
  }
  return "no-error";
};

describe("bindQrRequest account matching", () => {
  it("a foreign fingerprint is not this account's request", () => {
    expect(code(() => bindQrRequest(evmTx({ xfp: 0xdeadbeef }), FACTS))).toBe("account-mismatch");
  });

  it("a path that is not the group's leaf is not this account", () => {
    expect(code(() => bindQrRequest(evmTx({ path: [44 + H, 60 + H, H, 0, 9] }), FACTS))).toBe(
      "account-mismatch",
    );
    expect(code(() => bindQrRequest(tronRequest("message", { path: EVM_PATH }), FACTS))).toBe(
      "account-mismatch",
    );
  });

  it("an evm address in any letter case is still the account's", () => {
    const [lower] = bindQrRequest(evmTx({ address: EVM_ADDR.toLowerCase() }), FACTS);
    expect(lower?.method).toBe("evm-sign");
    const [upper] = bindQrRequest(evmTx({ address: EVM_ADDR.toUpperCase() }), FACTS);
    expect(upper?.method).toBe("evm-sign");
  });

  it("a declared address that is not the account's is refused", () => {
    expect(
      code(() =>
        bindQrRequest(evmTx({ address: "0x00000000000000000000000000000000deadbeef" }), FACTS),
      ),
    ).toBe("account-mismatch");
    expect(
      code(() =>
        bindQrRequest(
          solanaRequest("message", new Uint8Array(64), {
            address: "7yWWGStvkEG1Zmhx6uasJtWCJziofM4uQeVj5tqViQh",
          }),
          FACTS,
        ),
      ),
    ).toBe("account-mismatch");
  });
});

describe("bindQrRequest evm", () => {
  it("binds a transaction to its chain's network with the qr origin", () => {
    const [input] = bindQrRequest(evmTx(), FACTS);
    expect(input).toMatchObject({
      method: "evm-sign",
      origin: { kind: "qr", declared: "qr.test" },
      account: { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" },
      network: SEPOLIA,
    });
    expect(input?.request.kind).toBe("evm.transaction");
  });

  it("request chain id disagreeing with the transaction's is a chain mismatch", () => {
    expect(code(() => bindQrRequest(evmTx({ chainId: 1 }), FACTS))).toBe("chain-mismatch");
  });

  it("a transaction on a network the wallet does not serve is refused", () => {
    expect(code(() => bindQrRequest(evmTx({ tx: { ...EVM_TX, chainId: 1 } }), FACTS))).toBe(
      "network-unknown",
    );
  });

  it("an authorization transaction is refused before the pipeline", () => {
    const auth = { ...EVM_TX, type: "eip7702" as const, authorization: { address: EVM_TX.to } };
    expect(code(() => bindQrRequest(evmTx({ tx: auth }), FACTS))).toBe("unsupported");
  });

  it("contract creation and self-calls are refused before the pipeline", () => {
    const { to: _to, ...noTo } = EVM_TX;
    expect(code(() => bindQrRequest(evmTx({ tx: noTo }), FACTS))).toBe("contract-creation");
    expect(
      code(() =>
        bindQrRequest(
          evmTx({ tx: { ...EVM_TX, to: EVM_ADDR.toLowerCase(), data: "0xdead" } }),
          FACTS,
        ),
      ),
    ).toBe("self-call");
  });

  it("typed data binds through its domain chain id, not the request's", () => {
    const typedData = JSON.stringify({
      types: {
        EIP712Domain: [{ name: "chainId", type: "uint256" }],
        Mail: [{ name: "c", type: "string" }],
      },
      primaryType: "Mail",
      domain: { chainId: 11155111 },
      message: { c: "hi" },
    });
    const request: QrRequest = {
      family: "evm",
      kind: "typed-data",
      path: EVM_PATH,
      xfp: XFP,
      chainId: 1,
      typedData,
    };
    expect(code(() => bindQrRequest(request, FACTS))).toBe("chain-mismatch");
    const noChain: QrRequest = {
      family: "evm",
      kind: "typed-data",
      path: EVM_PATH,
      xfp: XFP,
      typedData,
    };
    const [input] = bindQrRequest(noChain, FACTS);
    expect(input?.network).toBe(SEPOLIA);
    const other = JSON.stringify({
      ...JSON.parse(typedData),
      domain: { chainId: 42161 },
    });
    expect(code(() => bindQrRequest({ ...noChain, typedData: other }, FACTS))).toBe(
      "network-unknown",
    );
  });

  it("a personal message falls back to the mainnet label when no chain is carried", () => {
    const request: QrRequest = {
      family: "evm",
      kind: "personal-message",
      path: EVM_PATH,
      xfp: XFP,
      message: new Uint8Array([104, 105]),
    };
    const [input] = bindQrRequest(request, FACTS);
    expect(input).toMatchObject({
      method: "evm-sign",
      network: "eip155:1",
      origin: { kind: "qr" },
    });
    expect(input?.origin).toStrictEqual({ kind: "qr" });
  });
});

describe("bindQrRequest solana", () => {
  it("a transaction produces one candidate per enabled network, mainnet first", () => {
    const facts: QrAccountFacts = {
      ...FACTS,
      networks: {
        ...FACTS.networks,
        solana: [SOLANA_MAINNET, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
      },
    };
    const inputs = bindQrRequest(
      solanaRequest("transaction", solanaMessageBytes(SOLANA_ADDR)),
      facts,
    );
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input).toMatchObject({
        method: "solana-sign",
        origin: { kind: "qr" },
        account: { walletId: "w", groupIndex: 0, address: SOLANA_ADDR },
      });
      expect(solanaSend(input)).toBe(false);
    }
  });

  it("an account that is not a required signer is not this request's signer", () => {
    const other = "7yWWGStvkEG1Zmhx6uasJtWCJziofM4uQeVj5tqViQh";
    const request = solanaRequest("transaction", solanaMessageBytes(other), {
      address: undefined as unknown as string,
    });
    /* The foreign fee payer's message cannot carry this account — declared address alone binds
       only for the account itself. */
    expect(code(() => bindQrRequest(request, FACTS))).toBe("account-mismatch");
  });

  it("a message binds to the first solana network", () => {
    const [input] = bindQrRequest(solanaRequest("message", new Uint8Array(8).fill(65)), FACTS);
    expect(input).toMatchObject({ method: "solana-sign", network: SOLANA_MAINNET });
  });
});

describe("bindQrRequest tron", () => {
  it("a transaction produces one candidate per enabled TRON network", () => {
    const facts: QrAccountFacts = {
      ...FACTS,
      networks: { ...FACTS.networks, tron: [TRON_MAINNET, "tron:2494104990"] },
    };
    const inputs = bindQrRequest(tronRequest("transaction"), facts);
    expect(inputs.map((i) => i.network)).toStrictEqual([TRON_MAINNET, "tron:2494104990"]);
  });

  it("a message binds to the first TRON network", () => {
    const [input] = bindQrRequest(tronRequest("message"), FACTS);
    expect(input).toMatchObject({ method: "tron-sign", network: TRON_MAINNET });
  });
});

describe("bindQrRequest bitcoin", () => {
  it("binds a PSBT input of the selected group to its template", () => {
    const [input] = bindQrRequest(bitcoinRequest(qrPsbt({ path: BTC84_PATH })), FACTS);
    expect(input).toMatchObject({
      method: "bitcoin-sign",
      origin: { kind: "qr" },
      account: { walletId: "w", groupIndex: 0 },
      network: BITCOIN_MAINNET,
    });
    expect(psbtSend(input)).toBe(false);
    expect(psbtSigns(input)).toStrictEqual([{ index: 0, sigHash: "ALL", template: "btc.bip84" }]);
  });

  it("no input carrying our fingerprint means nothing to sign", () => {
    expect(code(() => bindQrRequest(bitcoinRequest(qrPsbt({})), FACTS))).toBe("nothing-to-sign");
    expect(
      code(() =>
        bindQrRequest(bitcoinRequest(qrPsbt({ path: BTC84_PATH, fingerprint: 0xdeadbeef })), FACTS),
      ),
    ).toBe("nothing-to-sign");
  });

  it("our fingerprint under a wrong group or purpose is refused, not skipped", () => {
    const wrongGroup = [84 + H, H, 9 + H, 0, 0];
    expect(code(() => bindQrRequest(bitcoinRequest(qrPsbt({ path: wrongGroup })), FACTS))).toBe(
      "account-mismatch",
    );
    const wrongPurpose = [44 + H, H, H, 0, 0];
    expect(code(() => bindQrRequest(bitcoinRequest(qrPsbt({ path: wrongPurpose })), FACTS))).toBe(
      "account-mismatch",
    );
  });

  it("a path outside the account's shape is refused, not skipped", () => {
    const coinAboveTestnet = [84 + H, 2 + H, H, 0, 0];
    expect(
      code(() => bindQrRequest(bitcoinRequest(qrPsbt({ path: coinAboveTestnet })), FACTS)),
    ).toBe("account-mismatch");
    const internalChain = [84 + H, H, H, 2, 0];
    expect(code(() => bindQrRequest(bitcoinRequest(qrPsbt({ path: internalChain })), FACTS))).toBe(
      "account-mismatch",
    );
    const hardenedLeaf = [84 + H, H, H, 0, H];
    expect(code(() => bindQrRequest(bitcoinRequest(qrPsbt({ path: hardenedLeaf })), FACTS))).toBe(
      "account-mismatch",
    );
    const unknownPurpose = [H, H, H, 0, 0];
    expect(code(() => bindQrRequest(bitcoinRequest(qrPsbt({ path: unknownPurpose })), FACTS))).toBe(
      "account-mismatch",
    );
    /* An unknown purpose is a path problem, not a script one — the message says which. */
    expect(() => bindQrRequest(bitcoinRequest(qrPsbt({ path: unknownPurpose })), FACTS)).toThrow(
      /derivation path/,
    );
  });

  it("an input whose prevout script is unknown cannot be matched", () => {
    const tx = new Transaction({ version: 2 });
    const key = pubkeyAt("m/84'/0'/0'/0/0");
    tx.addInput({ txid: new Uint8Array(32).fill(7), index: 0 });
    tx.updateInput(0, {
      bip32Derivation: [[key, { fingerprint: XFP, path: [...BTC84_PATH] }]],
    });
    tx.addOutput({ script: p2wpkh(key, NETWORK).script, amount: 90_000n });
    expect(code(() => bindQrRequest(bitcoinRequest(tx.toPSBT(0)), FACTS))).toBe("account-mismatch");
  });

  it("a bip49 p2sh-p2wpkh input binds to its template", () => {
    const key = pubkeyAt("m/49'/0'/0'/0/0");
    const inner = p2wpkh(key, NETWORK);
    const psbt = qrPsbt({
      path: [49 + H, H, H, 0, 0],
      script: p2sh(inner, NETWORK).script,
      redeemScript: inner.script,
    });
    const [input] = bindQrRequest(bitcoinRequest(psbt), FACTS);
    expect(psbtSigns(input)).toStrictEqual([{ index: 0, sigHash: "ALL", template: "btc.bip49" }]);
  });

  it("a p2sh input whose redeem script is not a p2wpkh wrapper is refused", () => {
    const ms = p2ms(2, [pubkeyAt("m/49'/0'/0'/0/0"), pubkeyAt("m/49'/0'/0'/0/1")]);
    expect(
      code(() =>
        bindQrRequest(
          bitcoinRequest(
            qrPsbt({
              path: [49 + H, H, H, 0, 0],
              script: p2sh(ms, NETWORK).script,
              redeemScript: ms.script,
            }),
          ),
          FACTS,
        ),
      ),
    ).toBe("multisig-unsupported");
    /* A p2sh input without its redeem script cannot even be classified. */
    const key = pubkeyAt("m/49'/0'/0'/0/0");
    const inner = p2wpkh(key, NETWORK);
    expect(
      code(() =>
        bindQrRequest(
          bitcoinRequest(
            qrPsbt({ path: [49 + H, H, H, 0, 0], script: p2sh(inner, NETWORK).script }),
          ),
          FACTS,
        ),
      ),
    ).toBe("multisig-unsupported");
  });

  it("a witness script is refused before the prevout checks even when it is all the input has", () => {
    const tx = new Transaction({ version: 2, disableScriptCheck: true });
    const key = pubkeyAt("m/84'/0'/0'/0/0");
    tx.addInput({
      txid: new Uint8Array(32).fill(7),
      index: 0,
      witnessScript: p2ms(2, [key, pubkeyAt("m/84'/0'/0'/0/1")]).script,
      bip32Derivation: [[key, { fingerprint: XFP, path: [...BTC84_PATH] }]],
    });
    tx.addOutput({ script: p2wpkh(key, NETWORK).script, amount: 90_000n });
    expect(code(() => bindQrRequest(bitcoinRequest(tx.toPSBT(0)), FACTS))).toBe(
      "multisig-unsupported",
    );
  });

  it("a redeem script outside a p2sh input is malformed before any matching", () => {
    /* The builder's own script check must be bypassed to even carry this field — the parser's
       still runs. */
    const tx = new Transaction({ version: 2, disableScriptCheck: true });
    const key = pubkeyAt("m/84'/0'/0'/0/0");
    tx.addInput({
      txid: new Uint8Array(32).fill(7),
      index: 0,
      witnessUtxo: { script: p2wpkh(key, NETWORK).script, amount: 100_000n },
      redeemScript: p2wpkh(key, NETWORK).script,
      bip32Derivation: [[key, { fingerprint: XFP, path: [...BTC84_PATH] }]],
    });
    tx.addOutput({ script: p2wpkh(key, NETWORK).script, amount: 90_000n });
    expect(code(() => bindQrRequest(bitcoinRequest(tx.toPSBT(0)), FACTS))).toBe("malformed");
  });

  it("a multisig or script-path input is refused", () => {
    expect(
      code(() =>
        bindQrRequest(
          bitcoinRequest(
            qrPsbt({
              path: BTC84_PATH,
              witnessScript: p2ms(2, [
                pubkeyAt("m/84'/0'/0'/0/0"),
                pubkeyAt("m/84'/0'/0'/0/1"),
                pubkeyAt("m/84'/0'/0'/0/2"),
              ]).script,
              script: p2wsh(
                p2ms(2, [
                  pubkeyAt("m/84'/0'/0'/0/0"),
                  pubkeyAt("m/84'/0'/0'/0/1"),
                  pubkeyAt("m/84'/0'/0'/0/2"),
                ]),
                NETWORK,
              ).script,
            }),
          ),
          FACTS,
        ),
      ),
    ).toBe("multisig-unsupported");
    expect(
      code(() =>
        bindQrRequest(
          bitcoinRequest(
            qrPsbt({ path: [86 + H, H, H, 0, 0], tap: true, leafHashes: [new Uint8Array(32)] }),
          ),
          FACTS,
        ),
      ),
    ).toBe("multisig-unsupported");
    /* A script-multisig prevout alone is refused as multisig, not as a script mismatch. */
    const ms = p2ms(2, [pubkeyAt("m/84'/0'/0'/0/0"), pubkeyAt("m/84'/0'/0'/0/1")]);
    expect(
      code(() =>
        bindQrRequest(
          bitcoinRequest(qrPsbt({ path: BTC84_PATH, script: p2wsh(ms, NETWORK).script })),
          FACTS,
        ),
      ),
    ).toBe("multisig-unsupported");
  });

  it("only ALL and SINGLE|ANYONECANPAY sighashes bind", () => {
    const single = bindQrRequest(
      bitcoinRequest(qrPsbt({ path: BTC84_PATH, sighashType: 0x83 })),
      FACTS,
    );
    expect(psbtSigns(single[0])?.[0]?.sigHash).toBe("SINGLE|ANYONECANPAY");
    expect(
      code(() =>
        bindQrRequest(bitcoinRequest(qrPsbt({ path: BTC84_PATH, sighashType: 0x02 })), FACTS),
      ),
    ).toBe("sighash-unsupported");
  });

  it("the taproot DEFAULT sighash binds only on a taproot input", () => {
    const tap = bindQrRequest(
      bitcoinRequest(qrPsbt({ path: [86 + H, H, H, 0, 0], tap: true, sighashType: 0 })),
      FACTS,
    );
    expect(psbtSigns(tap[0])?.[0]?.sigHash).toBe("ALL");
    expect(
      code(() =>
        bindQrRequest(bitcoinRequest(qrPsbt({ path: BTC84_PATH, sighashType: 0 })), FACTS),
      ),
    ).toBe("sighash-unsupported");
  });

  it("coin type decides the network; mixed or unserved ones are refused", () => {
    const testnetPath = [84 + H, 1 + H, H, 0, 0];
    expect(code(() => bindQrRequest(bitcoinRequest(qrPsbt({ path: testnetPath })), FACTS))).toBe(
      "network-ambiguous",
    );
    const facts: QrAccountFacts = {
      ...FACTS,
      networks: { ...FACTS.networks, bitcoin: [BITCOIN_MAINNET, TESTNET4] },
    };
    const [input] = bindQrRequest(bitcoinRequest(qrPsbt({ path: testnetPath })), facts);
    expect(input?.network).toBe(TESTNET4);
    /* Several enabled test networks cannot pick the input's one. */
    const SIGNET = "bip122:00000008819873e925422c1ff0f99f7c";
    const several: QrAccountFacts = {
      ...FACTS,
      networks: { ...FACTS.networks, bitcoin: [BITCOIN_MAINNET, TESTNET4, SIGNET] },
    };
    expect(code(() => bindQrRequest(bitcoinRequest(qrPsbt({ path: testnetPath })), several))).toBe(
      "network-ambiguous",
    );
  });

  it("inputs spanning two coin types are network-ambiguous", () => {
    const facts: QrAccountFacts = {
      ...FACTS,
      networks: { ...FACTS.networks, bitcoin: [BITCOIN_MAINNET, TESTNET4] },
    };
    const mixed = qrPsbtMulti([{ path: [84 + H, H, H, 0, 0] }, { path: [84 + H, 1 + H, H, 0, 0] }]);
    expect(code(() => bindQrRequest(bitcoinRequest(mixed), facts))).toBe("network-ambiguous");
  });
});

describe("every candidate carries the selected account and a qr origin", () => {
  const requests: ReadonlyArray<readonly [string, QrRequest]> = [
    ["evm transaction", evmTx()],
    [
      "evm typed data",
      {
        family: "evm",
        kind: "typed-data",
        path: EVM_PATH,
        xfp: XFP,
        typedData: JSON.stringify({
          types: {
            EIP712Domain: [{ name: "name", type: "string" }],
            Mail: [{ name: "c", type: "string" }],
          },
          primaryType: "Mail",
          domain: { name: "t" },
          message: { c: "hi" },
        }),
      },
    ],
    [
      "evm personal message",
      {
        family: "evm",
        kind: "personal-message",
        path: EVM_PATH,
        xfp: XFP,
        message: new Uint8Array([104, 105]),
      },
    ],
    ["solana transaction", solanaRequest("transaction", solanaMessageBytes(SOLANA_ADDR))],
    ["solana message", solanaRequest("message", new Uint8Array(8).fill(65))],
    ["tron transaction", tronRequest("transaction")],
    ["tron message", tronRequest("message")],
    ["bitcoin psbt", bitcoinRequest(qrPsbt({ path: BTC84_PATH }))],
  ];

  it.each(requests)("binds %s", (_name, request) => {
    const inputs = bindQrRequest(request, FACTS);
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.origin?.kind).toBe("qr");
      expect(input.account).toMatchObject({ walletId: "w", groupIndex: 0 });
    }
  });
});
