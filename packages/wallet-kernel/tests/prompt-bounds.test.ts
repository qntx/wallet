/**
 * The platform's verification dialog has a hard size the kernel now honors: an over-long prompt
 * counts as blind — refused before any keystore call while blind signing is off, and shown as the
 * blind title plus every warning and caveat row, the longest whole-line detail prefix that fits and
 * one closing count line when on. The kernel truncates; the OS never clips kernel text — and a
 * prompt whose warnings alone cannot fit is refused. Hosts with no keystore show no kernel text and
 * are unchanged.
 */
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { p2wpkh } from "@scure/btc-signer/payment.js";
import { SigHash, Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import type { IntentWarningKind } from "@qntx/wallet-chains";
import { decodeBitcoinPsbt, normalizeBitcoin } from "@qntx/wallet-chains/bitcoin";
import { decodeEvm, encodeBatchExecute, normalizeEvm } from "@qntx/wallet-chains/evm";
import { decodeSolana } from "@qntx/wallet-chains/solana";
import { buildTronRawData, decodeTron } from "@qntx/wallet-chains/tron";
import type {
  ProtocolValue,
  DeviceDisplay,
  HardwareDevice,
  SparkApprovalSummary,
} from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import { boundChainPrompt, chainPrompt, CATALOGS } from "../src/modules/chains/prompt.ts";
import type { PromptIntent } from "../src/modules/chains/prompt.ts";
import { devicePromptLine } from "../src/modules/signers/prompt.ts";
import { sparkPrompt } from "../src/modules/spark/prompt.ts";
import type { KeystorePrompt } from "../src/platform.ts";
import { cardPrompt, corePrompt, codePoints, PROMPT_BOUNDS, promptFits } from "../src/prompts.ts";
import type { CardPromptKind, CorePromptKind } from "../src/prompts.ts";
import { createHarness } from "./harness.ts";
import type { KernelResponse } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";

const lastPrompt = (calls: ReadonlyArray<KeystoreCall>): KeystorePrompt | undefined =>
  calls.findLast((c): c is KeystoreCall & { prompt?: KeystorePrompt } => "prompt" in c)?.prompt;

const IOS = PROMPT_BOUNDS.ios;
const ANDROID = PROMPT_BOUNDS.android;
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TO = "0x00000000000000000000000000000000DeaDBeef";

const ok = (response: KernelResponse): ProtocolValue => {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
};
const errCode = (response: KernelResponse): string | undefined =>
  "err" in response ? response.err.code : undefined;
const field = (value: ProtocolValue, key: string): ProtocolValue => {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  const v = value[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
};
const str = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};

describe("promptFits measures lines and code points against the platform bound", () => {
  const prompt = (lines: number, charsPerLine: number, title = "t") => ({
    title,
    description: Array.from({ length: lines }, () => "x".repeat(charsPerLine)).join("\n"),
  });

  it.each([
    [
      "ios exactly at limit",
      { title: "t", description: prompt(IOS.lines, 1).description },
      IOS,
      true,
    ],
    [
      "ios one line over",
      { title: "t", description: prompt(IOS.lines + 1, 1).description },
      IOS,
      false,
    ],
    [
      "ios one character over",
      { title: "t", description: "x".repeat(IOS.characters + 1) },
      IOS,
      false,
    ],
    [
      "ios exactly at characters",
      { title: "t", description: "x".repeat(IOS.characters) },
      IOS,
      true,
    ],
    ["android title at limit", { title: "t".repeat(60), description: "x" }, ANDROID, true],
    ["android title one over", { title: "t".repeat(61), description: "x" }, ANDROID, false],
    ["android title ignored on ios", { title: "t".repeat(500), description: "x" }, IOS, true],
    [
      "android lines at limit",
      { title: "t", description: prompt(ANDROID.lines, 1).description },
      ANDROID,
      true,
    ],
    [
      "android lines over",
      { title: "t", description: prompt(ANDROID.lines + 1, 1).description },
      ANDROID,
      false,
    ],
  ])("%s", (_name, prompt, bound, fits) => {
    expect(promptFits(prompt, bound)).toBe(fits);
  });

  it("counts code points, not UTF-16 units", () => {
    // An astral emoji is one code point but two UTF-16 units.
    const emoji = { title: "t", description: "🔑".repeat(IOS.characters) };
    expect(promptFits(emoji, IOS)).toBe(true);
    expect(emoji.description).toHaveLength(IOS.characters * 2);
    expect(codePoints(emoji.description)).toBe(IOS.characters);
    const cjk = { title: "t", description: "密码".repeat(IOS.characters / 2) };
    expect(promptFits(cjk, IOS)).toBe(true);
    const over = { title: "t", description: "🔑".repeat(IOS.characters + 1) };
    expect(promptFits(over, IOS)).toBe(false);
  });
});

describe("boundChainPrompt", () => {
  const transfer: PromptIntent = {
    summary: "transfer",
    outflows: [
      {
        to: TO,
        amount: {
          asset: "eip155:1/slip44:60",
          amount: "50000000000000000",
          decimals: 18,
          symbol: "ETH",
        },
        verified: true,
      },
    ],
    approvals: [],
    fee: {
      max: { asset: "eip155:1/slip44:60", amount: "400000000000000", decimals: 18, symbol: "ETH" },
    },
    verifiability: "full",
  };
  const batch = (n: number): PromptIntent => ({
    summary: "batch",
    outflows: Array.from({ length: n }, (_, i) => ({
      to: `0x00000000000000000000000000000000000000${10 + i}`,
      amount: {
        asset: "eip155:1/slip44:60",
        amount: "1",
        decimals: 18,
        symbol: "ETH",
      },
      verified: true,
    })),
    approvals: [],
    fee: {
      max: { asset: "eip155:1/slip44:60", amount: "1", decimals: 18, symbol: "ETH" },
    },
    verifiability: "full",
  });

  it("returns the rendered prompt unchanged when it fits", () => {
    const { prompt, oversize } = boundChainPrompt("en", transfer, IOS);
    expect(oversize).toBe(false);
    expect(prompt).toStrictEqual(chainPrompt("en", transfer));
  });

  it.each(["en", "zh-Hans"] as const)(
    "%s: an over-line prompt becomes the blind title plus a whole-line prefix and the count line",
    (locale) => {
      const { prompt, oversize } = boundChainPrompt(locale, batch(20), IOS);
      expect(oversize).toBe(true);
      expect(prompt.title).toBe(CATALOGS[locale].blindTitle);
      const lines = prompt.description.split("\n");
      expect(lines.length).toBeLessThanOrEqual(IOS.lines);
      expect(codePoints(prompt.description)).toBeLessThanOrEqual(IOS.characters);
      const last = lines.at(-1);
      const kept = lines.length - 1;
      expect(last).toBe(CATALOGS[locale].moreLines(20 - kept + 1));
      // Kept lines are whole, verbatim, in order — never cut inside a line.
      const original = chainPrompt(locale, batch(20)).description.split("\n");
      for (let i = 0; i < kept; i++) {
        expect(lines[i]).toBe(original[i]);
      }
    },
  );

  it("truncates by characters too, not only by lines", () => {
    const wide: PromptIntent = {
      ...batch(4),
      outflows: batch(4).outflows.map((o) => ({
        ...o,
        to: `0x${"ab".repeat(200)}`,
      })),
    };
    const { prompt, oversize } = boundChainPrompt("en", wide, IOS);
    expect(oversize).toBe(true);
    expect(promptFits(prompt, { lines: 8, characters: 400 })).toBe(true);
    const lines = prompt.description.split("\n");
    expect(lines.at(-1)).toBe(CATALOGS.en.moreLines(wide.outflows.length + 2 - lines.length));
  });

  it("a title bound of exactly the blind title's width still carries the warnings", () => {
    /* `>` not `>=`: a bound that fits the blind title to the code point is a dialog that can
       still show every lead row under it — only one less must refuse. */
    const bound = { ...IOS, title: codePoints(CATALOGS.en.blindTitle) };
    const { prompt, oversize } = boundChainPrompt("en", batch(20), bound);
    expect(oversize).toBe(true);
    expect(prompt.title).toBe(CATALOGS.en.blindTitle);
  });

  it("a title bound one code point under the blind title refuses the dialog", () => {
    const bound = { ...IOS, title: codePoints(CATALOGS.en.blindTitle) - 1 };
    expect(() => boundChainPrompt("en", batch(20), bound)).toThrow(
      "the prompt's warnings do not fit the dialog",
    );
  });

  it("a single over-long first line is replaced by the count line alone", () => {
    const giant: PromptIntent = {
      ...transfer,
      outflows: [
        {
          to: `0x${"ab".repeat(500)}`,
          amount: {
            asset: "eip155:1/slip44:60",
            amount: "1",
            decimals: 18,
            symbol: "ETH",
          },
          verified: true,
        },
      ],
    };
    const { prompt, oversize } = boundChainPrompt("en", giant, IOS);
    expect(oversize).toBe(true);
    expect(prompt.description).toBe(CATALOGS.en.moreLines(2));
    expect(prompt.title).toBe(CATALOGS.en.blindTitle);
    expect(promptFits(prompt, IOS)).toBe(true);
  });
});

describe("every fixed prompt the kernel can show fits both platform bounds", () => {
  const kinds: ReadonlyArray<CorePromptKind> = [
    "unlock",
    "create",
    "export-mnemonic",
    "export-private-key",
    "delete-wallet",
    "remove-private-key",
    "backup",
    "disable-backup",
    "manage-factors",
    "app-lock",
    "enable-blind-signing",
    "disable-blind-signing",
    "reset",
  ];

  it.each(kinds.flatMap((k) => (["en", "zh-Hans"] as const).map((l) => [k, l] as const)))(
    "core prompt %s (%s) fits ios and android",
    (kind, locale) => {
      const prompt = corePrompt(locale, kind);
      expect(promptFits(prompt, IOS)).toBe(true);
      expect(promptFits(prompt, ANDROID)).toBe(true);
    },
  );

  const cardKinds: ReadonlyArray<CardPromptKind> = [
    "card-add",
    "card-change-access",
    "card-erase",
    "card-create",
    "card-transfer",
    "card-reseal",
    "card-forget-access",
  ];

  it.each(cardKinds.flatMap((k) => (["en", "zh-Hans"] as const).map((l) => [k, l] as const)))(
    "card prompt %s (%s) fits ios and android",
    (kind, locale) => {
      const prompt = cardPrompt(locale, kind, ["ABCD-1234"]);
      expect(promptFits(prompt, IOS)).toBe(true);
      expect(promptFits(prompt, ANDROID)).toBe(true);
    },
  );

  it("card-add carries its exact identity-verification wording in both locales", () => {
    expect(cardPrompt("zh-Hans", "card-add", ["ABCD-1234"])).toStrictEqual({
      title: "添加卡钱包",
      description: "验证身份以将卡上的钱包添加到此设备",
    });
    expect(cardPrompt("en", "card-add", ["ABCD-1234"])).toStrictEqual({
      title: "Add card wallet",
      description: "Verify your identity to add the wallet on a card to this device",
    });
  });

  const sparkKinds: ReadonlyArray<SparkApprovalSummary> = [
    {
      kind: "transfer",
      receivers: [{ identityPublicKey: new Uint8Array(33).fill(0xab), amountSats: 9_999_999_999 }],
    },
    {
      kind: "lightning",
      paymentHash: new Uint8Array(32).fill(0xcd),
      invoiceAmountSats: 9_999_999_999,
      maxFeeSats: 9_999_999,
    },
    {
      kind: "exit",
      amountSats: 9_999_999_999,
      address: `bc1q${"x".repeat(90)}`,
      maxFeeSats: 9_999_999,
    },
    {
      kind: "onchain",
      address: `bc1q${"x".repeat(90)}`,
      maxFeeSats: 9_999_999,
    },
    {
      kind: "token",
      tokenIdentifier: new Uint8Array(32).fill(0xef),
      receivers: [{ ownerPublicKey: new Uint8Array(33).fill(0xab), amount: "9".repeat(30) }],
    },
  ];

  it.each(sparkKinds.flatMap((s) => (["en", "zh-Hans"] as const).map((l) => [s, l] as const)))(
    "spark approval %s (%s) fits ios and android",
    (summary, locale) => {
      const prompt = sparkPrompt(locale, summary);
      expect(promptFits(prompt, IOS)).toBe(true);
      expect(promptFits(prompt, ANDROID)).toBe(true);
    },
  );

  it.each(
    (["en", "zh-Hans"] as const).flatMap((locale) => {
      const displays: DeviceDisplay[] = ["clear", "blind"];
      const devices: HardwareDevice[] = ["keystone"];
      return displays.flatMap((display) =>
        devices.map((device) => [locale, display, device] as const),
      );
    }),
  )("device prompt line %s %s %s fits", (locale, display, device) => {
    expect(codePoints(devicePromptLine(locale, display, device))).toBeLessThanOrEqual(
      IOS.characters,
    );
  });
});

describe("a transaction prompt leads with its outflow line", () => {
  const firstContentLine = (description: string): string =>
    description
      .split("\n")
      .find((line) => !line.startsWith("Network:") && !line.startsWith("网络："))!;

  it("evm transfer", () => {
    const intent = decodeEvm(
      {
        kind: "evm.transaction",
        network: "eip155:1",
        account: { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" },
        tx: {
          type: "eip1559",
          chainId: 1,
          nonce: 0,
          gas: "0x5208",
          value: "0x16345785d8a0000",
          data: "0x",
          to: TO,
          maxFeePerGas: "0x59682f00",
          maxPriorityFeePerGas: "0x1",
          accessList: [],
        },
      } as never,
      TO,
    );
    expect(firstContentLine(chainPrompt("en", intent).description)).toMatch(/^Send .* to /);
  });

  it("solana transfer", () => {
    const payer = base58.encode(new Uint8Array(32).fill(0x11));
    const to = base58.encode(new Uint8Array(32).fill(0x22));
    const system = new Uint8Array(32);
    const data = new Uint8Array(12);
    new DataView(data.buffer).setUint32(0, 2, true);
    new DataView(data.buffer).setBigUint64(4, 1_000_000_000n, true);
    const message = new Uint8Array([
      0x80,
      1,
      0,
      1,
      3,
      ...base58.decode(payer),
      ...base58.decode(to),
      ...system,
      ...new Uint8Array(32).fill(0x33),
      1,
      2,
      2,
      0,
      2,
      12,
      ...data,
    ]);
    const intent = decodeSolana(
      {
        kind: "solana.transaction",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44-change" },
        message,
      } as never,
      payer,
    );
    expect(firstContentLine(chainPrompt("en", intent).description)).toMatch(/^Send .* to /);
  });

  it("tron transfer", () => {
    const owner = "TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG";
    const to = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC";
    const intent = decodeTron(
      {
        kind: "tron.transaction",
        network: "tron:728126428",
        account: { kind: "hd", walletId: "w", groupIndex: 0, template: "tron.bip44" },
        rawData: buildTronRawData(
          {
            refBlock: {
              number: 76050000,
              id: "0000000004886e501a2b3c4d5e6f78901a2b3c4d5e6f78901a2b3c4d5e6f7890",
            },
            expiration: 1_767_225_660_000,
            timestamp: 1_767_225_600_000,
          },
          { type: "TransferContract", owner, to, amount: 1_000_000n },
        ),
      } as never,
      owner,
    );
    expect(firstContentLine(chainPrompt("en", intent).description)).toMatch(/^Send .* to /);
  });

  it("bitcoin send", () => {
    const BTC_NET = "bip122:000000000019d6689c085ae165831e93";
    const script = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xcd)]);
    const prev = new Transaction({ version: 2 });
    prev.addInput({ txid: hexToBytes("07".repeat(32)), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script, amount: 100_000n });
    const tx = new Transaction({ version: 2 });
    tx.addInput({
      txid: prev.id,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script, amount: 100_000n },
      nonWitnessUtxo: prev.toBytes(true, false),
    });
    tx.addOutput({
      script: new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xab)]),
      amount: 90_000n,
    });
    const intent = decodeBitcoinPsbt({
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NET,
      account: { kind: "hd", walletId: "w", groupIndex: 0 },
      psbt: tx.toPSBT(0),
      sign: [{ index: 0, template: "btc.bip84" }],
    } as never);
    expect(firstContentLine(chainPrompt("en", intent).description)).toMatch(/^Send .* to /);
  });
});

describe("an over-long chain prompt counts as blind", () => {
  const setup = async (fake: ReturnType<typeof fakeKeystore>) => {
    const h = createHarness({ keystore: fake.keystore });
    await h.settle();
    const imported = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: { kind: "device" },
      }),
    );
    const session = str(imported, "session");
    const walletId = str(field(imported, "wallet"), "walletId");
    const account = { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" };
    const own = str(
      ok(
        await h.call(
          "wallet.accounts",
          { walletId, groupIndex: 0, template: "evm.bip44", network: "eip155:1" },
          session,
        ),
      ),
      "address",
    );
    const calls = Array.from({ length: 12 }, (_, i) => ({
      to: `0x00000000000000000000000000000000000000${10 + i}` as `0x${string}`,
      value: 1n,
      data: "0x" as `0x${string}`,
    }));
    const request = normalizeEvm({
      kind: "evm.transaction",
      network: "eip155:1",
      account,
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 0,
        gas: "0x5208",
        value: "0x0",
        data: encodeBatchExecute(calls),
        to: own as `0x${string}`,
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x1",
        accessList: [],
      },
    });
    return { h, session, request };
  };

  it("is refused as blind-signing-disabled before any keystore call while blind signing is off", async () => {
    const fake = fakeKeystore();
    const { h, session, request } = await setup(fake);
    const callsBefore = fake.calls.length;
    expect(
      errCode(await h.call("chain.sign", { request, verify: { kind: "hardware" } }, session)),
    ).toBe("blind-signing-disabled");
    expect(fake.calls.slice(callsBefore)).toStrictEqual([]);
  });

  it("shows the blind title, a whole-line prefix and the count line when blind signing is on", async () => {
    const fake = fakeKeystore();
    const { h, session, request } = await setup(fake);
    ok(
      await h.call(
        "vault.setBlindSigning",
        { enabled: true, verify: { kind: "hardware" } },
        session,
      ),
    );
    const res = await h.call("chain.sign", { request, verify: { kind: "hardware" } }, session);
    expect("err" in res).toBe(false);
    const prompt = lastPrompt(fake.calls);
    expect(prompt?.title).toBe(CATALOGS.en.blindTitle);
    const description = String(prompt?.description);
    const lines = description.split("\n");
    expect(lines.length).toBeLessThanOrEqual(IOS.lines);
    expect(codePoints(description)).toBeLessThanOrEqual(IOS.characters);
    expect(lines[0]).toBe("Network: Ethereum");
    expect(lines.at(-1)).toBe(CATALOGS.en.moreLines(15 - lines.length));
  });

  it("signs the same oversize request unbounded on a host with no keystore", async () => {
    const h = createHarness();
    await h.settle();
    const imported = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: {
          kind: "passkey",
          credentialId: new Uint8Array([7, 7, 7, 7]),
          prf: new Uint8Array(32).map((_, i) => i + 1),
        },
      }),
    );
    const session = str(imported, "session");
    const walletId = str(field(imported, "wallet"), "walletId");
    const account = { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" };
    const own = str(
      ok(
        await h.call(
          "wallet.accounts",
          { walletId, groupIndex: 0, template: "evm.bip44", network: "eip155:1" },
          session,
        ),
      ),
      "address",
    );
    const calls = Array.from({ length: 12 }, (_, i) => ({
      to: `0x00000000000000000000000000000000000000${10 + i}` as `0x${string}`,
      value: 1n,
      data: "0x" as `0x${string}`,
    }));
    const request = normalizeEvm({
      kind: "evm.transaction",
      network: "eip155:1",
      account,
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 0,
        gas: "0x5208",
        value: "0x0",
        data: encodeBatchExecute(calls),
        to: own as `0x${string}`,
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x1",
        accessList: [],
      },
    });
    const res = await h.call(
      "chain.sign",
      {
        request,
        verify: {
          kind: "passkey",
          credentialId: new Uint8Array([7, 7, 7, 7]),
          prf: new Uint8Array(32).map((_, i) => i + 1),
        },
      },
      session,
    );
    expect(errCode(res)).toBeUndefined();
  });
});

describe("a bounded prompt keeps every warning row", () => {
  const HARDENED = 0x80000000;
  const SEED = mnemonicToSeedSync(MNEMONIC);
  const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
  const MASTER_FP = HDKey.fromMasterSeed(SEED).fingerprint;
  const SIGHASH_WARNING =
    "Signed inputs bind only their same-index outputs; the rest of the transaction can change";

  /**
   * A bip84 spend of `m/84'/0'/0'/0/0` marked SIGHASH_SINGLE|ANYONECANPAY, paying `outputs` foreign
   * p2wpkh scripts plus `own` extra outputs on the group's receive chain at far indexes — each an
   * unusual own output the prompt warns about.
   */
  const listingPsbt = (outputs: number, own = 0): Uint8Array => {
    const master = HDKey.fromMasterSeed(SEED);
    const inputKey = master.derive("m/84'/0'/0'/0/0");
    const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
    prev.addInput({ txid: new Uint8Array(32).fill(0x11), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: p2wpkh(inputKey.publicKey!).script, amount: 100_000n });
    const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
    tx.addInput({
      txid: prev.id,
      index: 0,
      sequence: 0xfffffffd,
      sighashType: SigHash.SINGLE_ANYONECANPAY,
      witnessUtxo: { script: p2wpkh(inputKey.publicKey!).script, amount: 100_000n },
      nonWitnessUtxo: prev.toBytes(true, false),
      bip32Derivation: [
        [
          inputKey.publicKey!,
          { fingerprint: MASTER_FP, path: [84 + HARDENED, HARDENED, HARDENED, 0, 0] },
        ],
      ],
    });
    for (let i = 0; i < outputs; i++) {
      const script = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xa0 + i)]);
      tx.addOutput({ script, amount: 5000n });
    }
    for (let i = 0; i < own; i++) {
      const key = master.derive(`m/84'/0'/0'/0/${5000 + i}`);
      tx.addOutput({ script: p2wpkh(key.publicKey!).script, amount: 4000n });
      tx.updateOutput(tx.outputsLength - 1, {
        bip32Derivation: [
          [
            key.publicKey!,
            { fingerprint: MASTER_FP, path: [84 + HARDENED, HARDENED, HARDENED, 0, 5000 + i] },
          ],
        ],
      });
    }
    return tx.toPSBT(0);
  };

  const openVault = async (fake: ReturnType<typeof fakeKeystore>) => {
    const h = createHarness({ keystore: fake.keystore });
    await h.settle();
    const imported = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: { kind: "device" },
      }),
    );
    const session = str(imported, "session");
    const walletId = str(field(imported, "wallet"), "walletId");
    ok(
      await h.call(
        "vault.setBlindSigning",
        { enabled: true, verify: { kind: "hardware" } },
        session,
      ),
    );
    const request = (psbt: Uint8Array) =>
      normalizeBitcoin({
        kind: "bitcoin.psbt",
        origin: "internal",
        network: BTC_NETWORK,
        account: { kind: "hd", walletId, groupIndex: 0 },
        psbt,
        sign: [{ index: 0, template: "btc.bip84" }],
      });
    return { h, session, request };
  };

  it("a 13-output sighash listing signs on Android and the warning survives the bound", async () => {
    /* Android's keystore dialog bounds the prompt at 12 lines / 640 characters — the 14 send rows
       alone overflow it. */
    const fake = fakeKeystore("en-US", "android");
    const { h, session, request } = await openVault(fake);
    const req = request(listingPsbt(13));
    const res = await h.call("chain.sign", { request: req, verify: { kind: "hardware" } }, session);
    expect("err" in res).toBe(false);
    const prompt = lastPrompt(fake.calls);
    expect(prompt?.title).toBe(CATALOGS.en.blindTitle);
    const description = String(prompt?.description);
    /* The two lead rows — the partial-effects caveat and the sighash warning, the one row that
       says the signature does not bind the whole transaction — head the prompt, before every
       detail row the bound cut down. */
    const lines = description.split("\n");
    expect(lines[0]).toBe(CATALOGS.en.otherOutflows);
    expect(lines[1]).toBe(SIGHASH_WARNING);
    /* …and it is the same line the unbounded rendering carries, not a substitute. */
    const full = chainPrompt(
      "en",
      decodeBitcoinPsbt(req as Parameters<typeof decodeBitcoinPsbt>[0]),
    ).description;
    expect(full).toContain(SIGHASH_WARNING);
  });

  it("a PSBT whose warnings alone overflow the bound is refused even with blind signing on", async () => {
    /* Eight unusual own outputs produce eight warning rows; with the closing line they cannot fit
       iOS's 8-line dialog, so the request fails instead of signing behind a clipped prompt. */
    const fake = fakeKeystore("en-US", "ios");
    const { h, session, request } = await openVault(fake);
    const callsBefore = fake.calls.length;
    const res = await h.call(
      "chain.sign",
      { request: request(listingPsbt(0, 8)), verify: { kind: "hardware" } },
      session,
    );
    expect(errCode(res)).toBe("unsupported");
    expect(fake.calls.slice(callsBefore).filter((c) => "prompt" in c)).toStrictEqual([]);
  });

  const bigIntent = (over: Partial<PromptIntent> = {}): PromptIntent => ({
    summary: "transfer",
    network: "eip155:1",
    family: "evm",
    outflows: Array.from({ length: 20 }, (_, i) => ({
      to: `0x00000000000000000000000000000000000000${10 + i}`,
      amount: { asset: "eip155:1/slip44:60", amount: "1", decimals: 18, symbol: "ETH" },
      verified: true,
    })),
    approvals: [],
    fee: {
      max: { asset: "eip155:1/slip44:60", amount: "1", decimals: 18, symbol: "ETH" },
    },
    verifiability: "full",
    ...over,
  });
  /* A synthetic 5-line/160-character bound: every case overflows it, so each checks that its lead
     rows survive whole ahead of the detail rows that were cut. */
  const TIGHT = { title: 40, lines: 5, characters: 640 };

  const cases: ReadonlyArray<readonly [string, PromptIntent, ReadonlyArray<string>]> = [
    [
      "unverified-effects caveat",
      bigIntent({ verifiability: "opaque" }),
      [CATALOGS.en.unverifiedEffects],
    ],
    ["other-outflows caveat", bigIntent({ verifiability: "partial" }), [CATALOGS.en.otherOutflows]],
    [
      "external-inputs caveat",
      bigIntent({ verifiability: "opaque", family: "bitcoin" }),
      [CATALOGS.en.externalInputs],
    ],
    [
      "solana undecoded programs caveat",
      bigIntent({
        verifiability: "opaque",
        family: "solana",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        programs: ["Drainer111111111111111111111111111111111"],
      }),
      [
        CATALOGS.en.solanaPrograms("Drainer111111111111111111111111111111111"),
        CATALOGS.en.solanaProgramsWarning,
      ],
    ],
    [
      "solana lookup-table caveat",
      bigIntent({
        blind: "lookup-table-account",
        verifiability: "opaque",
        family: "solana",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        programs: ["Drainer111111111111111111111111111111111"],
      }),
      [
        CATALOGS.en.solanaLookupTable,
        CATALOGS.en.solanaPrograms("Drainer111111111111111111111111111111111"),
        CATALOGS.en.solanaProgramsWarning,
      ],
    ],
    [
      "tron unsupported contract caveat",
      bigIntent({
        blind: "tron-contract",
        family: "tron",
        tron: { contractType: "AccountUpdateContract", expiration: 0 },
      }),
      [CATALOGS.en.tronContract("AccountUpdateContract")],
    ],
    [
      "tron unshowable field caveat",
      bigIntent({
        blind: "tron-field",
        family: "tron",
        tron: { contractType: "TransferContract", expiration: 0 },
      }),
      [CATALOGS.en.tronField],
    ],
    [
      "tron takeover row",
      bigIntent({
        family: "tron",
        tron: {
          contractType: "AccountPermissionUpdateContract",
          expiration: 0,
          permissionUpdate: {
            owner: {
              type: "owner",
              id: 0,
              name: "owner",
              threshold: "1",
              parentId: 0,
              keys: [{ address: "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC", weight: "1" }],
            },
            actives: [],
          },
        },
      }),
      [CATALOGS.en.tronTakeover(["TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC"])],
    ],
    [
      "solana program-authority rows",
      bigIntent({
        verifiability: "opaque",
        family: "solana",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        programAuthority: [
          {
            program: "Drainer111111111111111111111111111111111",
            sol: true,
            accounts: [{ address: "TokenAcc11111111111111111111111111111111" }],
          },
        ],
      }),
      [
        CATALOGS.en.programAuthority("Drainer111111111111111111111111111111111", true),
        CATALOGS.en.programAuthorityAccounts("Drainer111111111111111111111111111111111", [
          CATALOGS.en.programAuthorityMaybeYours("TokenAcc11111111111111111111111111111111"),
        ]),
      ],
    ],
    [
      "solana program-authority blind row",
      bigIntent({
        blind: "program-authority",
        verifiability: "opaque",
        family: "solana",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        programAuthority: [
          { program: "Drainer111111111111111111111111111111111", sol: false, accounts: [] },
        ],
      }),
      [CATALOGS.en.programAuthorityUnbounded("Drainer111111111111111111111111111111111")],
    ],
    [
      "hidden-characters message hazard",
      {
        summary: "message",
        outflows: [],
        approvals: [],
        fee: undefined,
        verifiability: "opaque",
        blind: "message-bytes",
        message: { kind: "text", text: `pay backdoor\u202E\n${"x\n".repeat(30)}` },
      },
      [CATALOGS.en.textHazard["hidden-characters"]],
    ],
    [
      "unreadable fiat24 grant hazard",
      {
        summary: "message",
        outflows: [],
        approvals: [],
        fee: undefined,
        verifiability: "opaque",
        blind: "fiat24-session-grant",
        message: { kind: "text", text: `grant\n${"x\n".repeat(30)}` },
      },
      [CATALOGS.en.fiat24Grant],
    ],
  ];

  it.each(cases)("an oversize bounded prompt keeps the %s", (_name, intent, leadLines) => {
    const { prompt, oversize } = boundChainPrompt("en", intent, TIGHT);
    expect(oversize).toBe(true);
    const lines = prompt.description.split("\n");
    for (const [i, lead] of leadLines.entries()) {
      expect(lines[i], `lead row ${i}`).toBe(lead);
    }
    /* The kept rows end with the closing count line — whatever was cut is a detail row. */
    expect(lines.at(-1)).toMatch(/^… \d+ more lines? not shown$/);
  });

  it.each(Object.keys(CATALOGS.en.warnings) as IntentWarningKind[])(
    "an oversize bounded prompt keeps a %s warning",
    (kind) => {
      const intent = bigIntent({ warnings: [{ kind, message: "50 bps" }] });
      const { prompt, oversize } = boundChainPrompt("en", intent, TIGHT);
      expect(oversize).toBe(true);
      expect(prompt.description.split("\n")[0]).toBe(CATALOGS.en.warnings[kind]("50 bps"));
    },
  );

  it("lead rows alone over the line bound throw unsupported, whatever the intent's blind reason", () => {
    const warnings = Array.from({ length: TIGHT.lines }, (_, i) => ({
      kind: "platform-fee" as const,
      message: `${i} bps`,
    }));
    const err = (() => {
      try {
        boundChainPrompt("en", bigIntent({ warnings }), TIGHT);
      } catch (error) {
        return error as KernelError;
      }
      throw new Error("expected boundChainPrompt to refuse");
    })();
    expect(err).toBeInstanceOf(KernelError);
    expect(err.code).toBe("unsupported");
  });
});
