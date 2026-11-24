/**
 * The platform's verification dialog has a hard size the kernel now honors: an over-long prompt
 * counts as blind — refused before any keystore call while blind signing is off, and shown as the
 * blind title plus the longest whole-line prefix that fits with one closing count line when on. The
 * kernel truncates; the OS never clips kernel text. Hosts with no keystore show no kernel text and
 * are unchanged.
 */
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import { decodeBitcoinPsbt } from "@qntx/wallet-chains/bitcoin";
import { decodeEvm, encodeBatchExecute, normalizeEvm } from "@qntx/wallet-chains/evm";
import { decodeSolana } from "@qntx/wallet-chains/solana";
import { buildTronRawData, decodeTron } from "@qntx/wallet-chains/tron";
import type {
  ProtocolValue,
  DeviceDisplay,
  HardwareDevice,
  SparkApprovalSummary,
} from "@qntx/wallet/protocol";

import { boundChainPrompt, chainPrompt, CATALOGS } from "../src/modules/chains/prompt.ts";
import type { PromptIntent } from "../src/modules/chains/prompt.ts";
import { devicePromptLine } from "../src/modules/signers/prompt.ts";
import { sparkPrompt } from "../src/modules/spark/prompt.ts";
import type { KeystorePrompt } from "../src/platform.ts";
import { corePrompt, codePoints, PROMPT_BOUNDS, promptFits } from "../src/prompts.ts";
import type { CorePromptKind } from "../src/prompts.ts";
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
