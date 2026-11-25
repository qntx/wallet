// oxlint-disable vitest/no-conditional-in-test -- recorded fixtures narrow via guard throws
/**
 * The Ledger driver against a scripted device link: pairing and account fetches answer with
 * material derived from the speculos seed, sign replays the recorded speculos transcripts
 * byte-for-byte so the driver is exercised over real device responses, and the display matrix and
 * blind-setting prechecks run without hardware.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { p2pkh, p2wpkh, Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import type { KeyPath, TaskKey } from "@qntx/wallet-chains";
import { bitcoinNetwork, planBitcoinPsbt, planBitcoinMessage } from "@qntx/wallet-chains/bitcoin";
import { evmAddressFromPublicKey, planEvm } from "@qntx/wallet-chains/evm";
import { planSolana, solanaAddressFromPublicKey } from "@qntx/wallet-chains/solana";
import { planTron } from "@qntx/wallet-chains/tron";
import type { ChainSignRequest, ChainTemplate } from "@qntx/wallet/protocol";

import type { PinnedNode } from "../src/derive/pinned.ts";
import { KernelError } from "../src/errors.ts";
import type { ChainPlan } from "../src/modules/chains/run.ts";
import type { HardwarePin, SignContext } from "../src/modules/signers/driver.ts";
import { LEDGER_DRIVER } from "../src/modules/signers/ledger/driver.ts";
import { call, mapLedgerError } from "../src/modules/signers/ledger/errors.ts";
import { leafHash, merkleRoot } from "../src/modules/signers/ledger/protocol/bitcoin/merkle.ts";
import {
  mapCommitment,
  psbtV2Maps,
  stripUnhiddenDerivations,
} from "../src/modules/signers/ledger/protocol/bitcoin/psbt.ts";
import { LedgerError } from "../src/modules/signers/ledger/protocol/errors.ts";
import { edAt, nodeAt } from "./signers-fake.ts";
import {
  caseSteps,
  hex,
  ok,
  publicKeyAt,
  scriptedLedger,
  SEED,
  unhex,
  utf8Hex,
  vectorCase,
  xpubAt,
} from "./signers-ledger-fake.ts";

const H = 0x80_00_00_00;
const ACCOUNT_44: KeyPath = [H + 44, H, H];
const ACCOUNT_49: KeyPath = [H + 49, H, H];
const ACCOUNT_84: KeyPath = [H + 84, H, H];
const ACCOUNT_86: KeyPath = [H + 86, H, H];
const ETH_PATH: KeyPath = [H + 44, H + 60, H, 0, 0];
const TRX_PATH: KeyPath = [H + 44, H + 195, H, 0, 0];
const SOL_PATH: KeyPath = [H + 44, H + 501, H, H];
const BTC_MSG_PATH: KeyPath = [H + 44, H, H, 0, 0];

const hd = (template: ChainTemplate) => ({
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template,
});

const random = (length: number): Uint8Array => new Uint8Array(length).fill(0x42);

/**
 * The context the kernel hands `sign`: `display` is the driver's own verdict for the pair — the
 * ledger driver never reads it, so the verdict's fallback only matters for deliberately mismatched
 * request/stage fixtures the kernel never produces.
 */
const signContext = (
  request: ChainSignRequest,
  stage: ChainPlan,
  hardwarePin: HardwarePin = pin,
): SignContext => {
  const verdict = LEDGER_DRIVER.display(request, stage, pin);
  return {
    request,
    stage,
    pin: hardwarePin,
    display: verdict === "unsupported" ? "blind" : verdict,
    random,
  };
};

const code = async (job: () => Promise<unknown>): Promise<string> => {
  try {
    await job();
  } catch (error) {
    if (error instanceof KernelError || error instanceof LedgerError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected the call to fail");
};

const FINGERPRINT = unhex(vectorCase("bitcoin", "fingerprint").result as string);

const BTC_MSG_ADDRESS = ((): string => {
  const { address } = p2pkh(
    publicKeyAt(BTC_MSG_PATH),
    bitcoinNetwork("bip122:000000000019d6689c085ae165831e93").params,
  );
  if (address === undefined) {
    throw new Error("no p2pkh address");
  }
  return address;
})();

const pin: HardwarePin = {
  fingerprint: FINGERPRINT,
  nodes: [nodeAt(SEED, ACCOUNT_84), nodeAt(SEED, ACCOUNT_44)],
  ed25519: [],
};

const fingerprintStep = (bytes: Uint8Array = FINGERPRINT) => ({ response: ok(hex(bytes)) });

/**
 * Rewrite the contract slot's enum and type_url to `name` (same-length replacement) — used to
 * fabricate a raw transaction whose contract has no dedicated device screen.
 */
const renameContract = (rawData: Uint8Array, typeEnum: number, name: string): Uint8Array => {
  const out = Uint8Array.from(rawData);
  out[24] = typeEnum;
  const tail = out.findIndex((b, i) => b === 0x54 && out[i + 1] === 0x72);
  for (const [i, ch] of name.split("").entries()) {
    out[tail + i] = ch.codePointAt(0) ?? 0;
  }
  return out;
};

/** Append a byte to the signature the recorded `sign-psbt-tr` transcript yields. */
const extendYieldedSig = (
  steps: ReadonlyArray<{ apdu?: string; response: string }>,
): typeof steps =>
  steps.map((step) =>
    step.response.endsWith("84ff8e000")
      ? { ...step, response: `${step.response.slice(0, -4)}01e000` }
      : step,
  );

const xpubSteps = (paths: ReadonlyArray<KeyPath>) =>
  paths.map((path) => ({ response: ok(utf8Hex(xpubAt(path))) }));

const EVM_KEY: TaskKey = { path: ETH_PATH, publicKey: publicKeyAt(ETH_PATH) };
const TRX_KEY: TaskKey = { path: TRX_PATH, publicKey: publicKeyAt(TRX_PATH) };
const BTC84_KEY: TaskKey = {
  path: [H + 84, H, H, 0, 0],
  publicKey: publicKeyAt([H + 84, H, H, 0, 0]),
};
const BTC86_KEY: TaskKey = {
  path: [H + 86, H, H, 0, 0],
  publicKey: publicKeyAt([H + 86, H, H, 0, 0]),
};

const evmTxRequest = (
  tx: Extract<ChainSignRequest, { kind: "evm.transaction" }>["tx"],
): Extract<ChainSignRequest, { kind: "evm.transaction" }> => ({
  kind: "evm.transaction",
  network: "eip155:1",
  account: hd("evm.bip44"),
  tx,
});

const LEGACY_TX = {
  type: "legacy" as const,
  chainId: 1,
  nonce: 0,
  gas: "0x5208",
  gasPrice: "0x77359400",
  value: "0xde0b6b3a7640000",
  data: "0x" as const,
  to: "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae",
};

describe("ledger driver errors", () => {
  it("maps every ledger code to the kernel code", () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["device-locked", "device-locked"],
      ["app-not-open", "device-app-closed"],
      ["app-not-installed", "device-app-closed"],
      ["user-rejected", "device-rejected"],
      ["setting-required", "blind-signing-disabled"],
      ["unsupported", "unsupported"],
      ["invalid-input", "unsupported"],
      ["invalid-response", "integrity"],
      ["transport", "integrity"],
      ["device-fault", "unsupported"],
    ];
    for (const [from, to] of cases) {
      expect(mapLedgerError(new LedgerError(from as never, "m")).code).toBe(to);
    }
  });

  it("passes kernel errors through the call wrapper", async () => {
    const kernel = new KernelError("wrong-device", "not the paired device");
    await expect(call(async () => Promise.reject(kernel))).rejects.toBe(kernel);
  });
});

describe("ledger driver pair", () => {
  const link = () =>
    scriptedLedger("bitcoin", [
      fingerprintStep(),
      ...xpubSteps([ACCOUNT_44, ACCOUNT_49, ACCOUNT_84, ACCOUNT_86]),
    ]);

  it("pins the fingerprint and the four bitcoin account nodes", async () => {
    const fake = link();
    const result = await LEDGER_DRIVER.pair(fake.link);
    expect(hex(result.fingerprint)).toBe(hex(FINGERPRINT));
    expect(result.firmware).toMatch(/^Bitcoin \d+\.\d+\.\d+$/);
    expect(result.ed25519).toStrictEqual([]);
    const expected: PinnedNode[] = [ACCOUNT_44, ACCOUNT_49, ACCOUNT_84, ACCOUNT_86].map((path) =>
      nodeAt(SEED, path),
    );
    expect(result.nodes).toStrictEqual(expected);
    fake.done();
  });

  it("fails closed when a different app is open", async () => {
    const fake = scriptedLedger({ name: "Ethereum", version: "1.24.0" }, []);
    await expect(code(async () => LEDGER_DRIVER.pair(fake.link))).resolves.toBe(
      "device-app-closed",
    );
  });
});

describe("ledger driver accounts", () => {
  it("serves bitcoin nodes after checking the paired fingerprint", async () => {
    const fake = scriptedLedger("bitcoin", [fingerprintStep(), ...xpubSteps([ACCOUNT_84])]);
    const result = await LEDGER_DRIVER.accounts(
      fake.link,
      { secp256k1: [ACCOUNT_84], ed25519: [] },
      pin,
    );
    expect(result.nodes).toStrictEqual([nodeAt(SEED, ACCOUNT_84)]);
    fake.done();
  });

  it("rejects a device whose fingerprint is not the pin", async () => {
    const fake = scriptedLedger("bitcoin", [fingerprintStep(unhex("deadbeef"))]);
    await expect(
      code(async () =>
        LEDGER_DRIVER.accounts(fake.link, { secp256k1: [ACCOUNT_84], ed25519: [] }, pin),
      ),
    ).resolves.toBe("wrong-device");
  });

  it("serves ethereum nodes through the chain-code variant", async () => {
    const node = vectorCase("ethereum", "public-node");
    const fake = scriptedLedger("ethereum", [...node.commands]);
    const result = await LEDGER_DRIVER.accounts(
      fake.link,
      { secp256k1: [[H + 44, H + 60, H]], ed25519: [] },
      pin,
    );
    const expected = node.result as { publicKey: string; chainCode: string };
    expect(result.nodes).toStrictEqual([
      {
        path: [H + 44, H + 60, H],
        publicKey: unhex(expected.publicKey),
        chainCode: unhex(expected.chainCode),
      },
    ]);
    fake.done();
  });

  it("rejects paths spanning two apps", async () => {
    const fake = scriptedLedger("bitcoin", []);
    await expect(
      code(async () =>
        LEDGER_DRIVER.accounts(
          fake.link,
          { secp256k1: [ACCOUNT_84, [H + 44, H + 60, H]], ed25519: [] },
          pin,
        ),
      ),
    ).resolves.toBe("unsupported");
  });

  it("rejects an unknown coin family", async () => {
    const fake = scriptedLedger("bitcoin", []);
    await expect(
      code(async () =>
        LEDGER_DRIVER.accounts(fake.link, { secp256k1: [[H + 44, H + 999, H]], ed25519: [] }, pin),
      ),
    ).resolves.toBe("unsupported");
  });

  it("rejects a secp256k1 path without a coin and a non-solana ed25519 path", async () => {
    const fake = scriptedLedger("bitcoin", []);
    await expect(
      code(async () =>
        LEDGER_DRIVER.accounts(fake.link, { secp256k1: [[H + 44]], ed25519: [] }, pin),
      ),
    ).resolves.toBe("unsupported");
    await expect(
      code(async () =>
        LEDGER_DRIVER.accounts(fake.link, { secp256k1: [], ed25519: [[H + 44, H, H, H]] }, pin),
      ),
    ).resolves.toBe("unsupported");
  });

  it("serves solana ed25519 keys", async () => {
    const fake = scriptedLedger("solana", caseSteps("solana", "address"));
    const result = await LEDGER_DRIVER.accounts(
      fake.link,
      { secp256k1: [], ed25519: [SOL_PATH] },
      pin,
    );
    expect(result.ed25519).toStrictEqual([
      { path: SOL_PATH, publicKey: unhex(vectorCase("solana", "address").result as string) },
    ]);
    fake.done();
  });

  it("re-probes a pinned ethereum node before serving a new one", async () => {
    const pinnedEth: HardwarePin = {
      ...pin,
      nodes: [...pin.nodes, nodeAt(SEED, [H + 44, H + 60, H])],
    };
    const node = vectorCase("ethereum", "public-node");
    // Any-APDU steps: the first answers the re-probe of the pinned path, the second the new fetch.
    const answers = node.commands.map((c) => ({ response: c.response }));
    const fake = scriptedLedger("ethereum", [...answers, ...answers]);
    const result = await LEDGER_DRIVER.accounts(
      fake.link,
      { secp256k1: [[H + 44, H + 60, H + 1]], ed25519: [] },
      pinnedEth,
    );
    const expected = node.result as { publicKey: string };
    expect(result.nodes[0]?.publicKey).toStrictEqual(unhex(expected.publicKey));
    fake.done();
  });

  it("refuses a different device answering a pinned ethereum path", async () => {
    const pinnedEth: HardwarePin = {
      ...pin,
      nodes: [...pin.nodes, nodeAt(SEED, [H + 44, H + 60, H + 1])],
    };
    const node = vectorCase("ethereum", "public-node"); // answers the account-0 node
    const answers = node.commands.map((c) => ({ response: c.response }));
    const fake = scriptedLedger("ethereum", answers);
    await expect(
      code(async () =>
        LEDGER_DRIVER.accounts(
          fake.link,
          { secp256k1: [[H + 44, H + 60, H + 2]], ed25519: [] },
          pinnedEth,
        ),
      ),
    ).resolves.toBe("wrong-device");
  });

  it("refuses a pinned-node answer with the right chain code but a foreign public key", async () => {
    const pinnedEth: HardwarePin = {
      ...pin,
      nodes: [...pin.nodes, nodeAt(SEED, [H + 44, H + 60, H])],
    };
    /* The re-probed node's chain code is public — a forger can replay it verbatim. The proof is
       the whole node: a foreign public key under the honest chain code is still wrong-device. */
    const foreign = HDKey.fromMasterSeed(new Uint8Array(64).fill(0xb0)).derive("m/44'/60'/0'");
    const honest = HDKey.fromMasterSeed(SEED).derive("m/44'/60'/0'");
    const uncompressed = secp256k1.Point.fromBytes(foreign.publicKey!).toBytes(false);
    const response = ok(
      `41${hex(uncompressed)}` +
        `28${utf8Hex(evmAddressFromPublicKey(uncompressed).slice(2))}` +
        `${hex(honest.chainCode!)}`,
    );
    const fake = scriptedLedger("ethereum", [{ response }]);
    await expect(
      code(async () =>
        LEDGER_DRIVER.accounts(
          fake.link,
          { secp256k1: [[H + 44, H + 60, H + 2]], ed25519: [] },
          pinnedEth,
        ),
      ),
    ).resolves.toBe("wrong-device");
  });

  it("refuses a different device answering a pinned tron path", async () => {
    const pinnedTrx: HardwarePin = {
      ...pin,
      nodes: [...pin.nodes, nodeAt(SEED, [H + 44, H + 195, H + 1])],
    };
    const node = vectorCase("tron", "public-node"); // answers the account-0 node
    const answers = node.commands.map((c) => ({ response: c.response }));
    const fake = scriptedLedger("tron", answers);
    await expect(
      code(async () =>
        LEDGER_DRIVER.accounts(
          fake.link,
          { secp256k1: [[H + 44, H + 195, H + 2]], ed25519: [] },
          pinnedTrx,
        ),
      ),
    ).resolves.toBe("wrong-device");
  });

  it("refuses a different device answering a pinned solana key", async () => {
    const pinnedSol: HardwarePin = { ...pin, ed25519: [edAt(SEED, SOL_PATH)] };
    const foreign = edAt(SEED, [H + 44, H + 501, H + 1, H]).publicKey;
    const fake = scriptedLedger("solana", [{ response: ok(hex(foreign)) }]);
    await expect(
      code(async () =>
        LEDGER_DRIVER.accounts(
          fake.link,
          { secp256k1: [], ed25519: [[H + 44, H + 501, H + 1, H]] },
          pinnedSol,
        ),
      ),
    ).resolves.toBe("wrong-device");
  });
});

describe("ledger driver verifyAddress", () => {
  it("matches an evm address the device shows", async () => {
    const steps = caseSteps("ethereum", "address-display");
    const fake = scriptedLedger("ethereum", steps);
    const { address } = vectorCase("ethereum", "address-display").result as { address: string };
    const verdict = await LEDGER_DRIVER.verifyAddress(
      fake.link,
      { template: "evm.bip44", network: "eip155:1", path: ETH_PATH, address },
      pin,
    );
    expect(verdict).toStrictEqual({ method: "device", matched: true });
    fake.done();
  });

  it("refuses a user rejection as device-rejected", async () => {
    const fake = scriptedLedger("ethereum", [{ response: "6985" }]);
    await expect(
      code(async () =>
        LEDGER_DRIVER.verifyAddress(
          fake.link,
          {
            template: "evm.bip44",
            network: "eip155:1",
            path: ETH_PATH,
            address: "0x0000000000000000000000000000000000000000",
          },
          pin,
        ),
      ),
    ).resolves.toBe("device-rejected");
  });

  it("reports a different evm address as unmatched", async () => {
    const fake = scriptedLedger("ethereum", caseSteps("ethereum", "address-display"));
    const verdict = await LEDGER_DRIVER.verifyAddress(
      fake.link,
      {
        template: "evm.bip44",
        network: "eip155:1",
        path: ETH_PATH,
        address: "0x0000000000000000000000000000000000000000",
      },
      pin,
    );
    expect(verdict).toStrictEqual({ method: "device", matched: false });
    fake.done();
  });

  it("matches a solana address the device shows", async () => {
    const fake = scriptedLedger("solana", caseSteps("solana", "address-display"));
    const pubkey = unhex(vectorCase("solana", "address-display").result as string);
    const address = solanaAddressFromPublicKey(pubkey);
    const verdict = await LEDGER_DRIVER.verifyAddress(
      fake.link,
      {
        template: "solana.bip44-change",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        path: SOL_PATH,
        address,
      },
      pin,
    );
    expect(verdict).toStrictEqual({ method: "device", matched: true });
    fake.done();
  });

  it("reports a different solana address as unmatched", async () => {
    const fake = scriptedLedger("solana", caseSteps("solana", "address-display"));
    const verdict = await LEDGER_DRIVER.verifyAddress(
      fake.link,
      {
        template: "solana.bip44-change",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        path: SOL_PATH,
        address: solanaAddressFromPublicKey(new Uint8Array(32)),
      },
      pin,
    );
    expect(verdict).toStrictEqual({ method: "device", matched: false });
    fake.done();
  });

  it("refuses a bitcoin path that is not m/purpose'/coin'/account'/c/i", async () => {
    const fake = scriptedLedger("bitcoin", []);
    await expect(
      code(async () =>
        LEDGER_DRIVER.verifyAddress(
          fake.link,
          {
            template: "btc.bip84",
            network: "bip122:000000000019d6689c085ae165831e93",
            path: [H + 84, H, H, 0, 0, 7],
            address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
          },
          pin,
        ),
      ),
    ).resolves.toBe("integrity");
  });

  it("matches a bitcoin wallet address the device shows", async () => {
    const wpkhPin: HardwarePin = { ...pin, nodes: [nodeAt(SEED, ACCOUNT_84)] };
    const fake = scriptedLedger("bitcoin", caseSteps("bitcoin", "addr-display").slice(1));
    const address = vectorCase("bitcoin", "addr-display").result as string;
    const verdict = await LEDGER_DRIVER.verifyAddress(
      fake.link,
      {
        template: "btc.bip84",
        network: "bip122:000000000019d6689c085ae165831e93",
        path: [H + 84, H, H, 0, 2],
        address,
      },
      wpkhPin,
    );
    expect(verdict).toStrictEqual({ method: "device", matched: true });
    fake.done();
  });

  it("reports a different device address as unmatched", async () => {
    const steps = caseSteps("ethereum", "address-display");
    const fake = scriptedLedger("ethereum", steps);
    const verdict = await LEDGER_DRIVER.verifyAddress(
      fake.link,
      {
        template: "evm.bip44",
        network: "eip155:1",
        path: ETH_PATH,
        address: "0x0000000000000000000000000000000000000000",
      },
      pin,
    );
    expect(verdict).toStrictEqual({ method: "device", matched: false });
    fake.done();
  });
});

describe("ledger driver display", () => {
  it("clears a simple evm transaction, blinds calldata and contract creation", () => {
    const clear = planEvm(evmTxRequest(LEGACY_TX), EVM_KEY);
    expect(LEDGER_DRIVER.display(evmTxRequest(LEGACY_TX), clear, pin)).toBe("clear");
    const dataTx = evmTxRequest({ ...LEGACY_TX, data: "0x1234" });
    expect(LEDGER_DRIVER.display(dataTx, planEvm(dataTx, EVM_KEY), pin)).toBe("blind");
    const create = evmTxRequest({
      type: "legacy",
      chainId: 1,
      nonce: 0,
      gas: "0x5208",
      gasPrice: "0x77359400",
      value: "0xde0b6b3a7640000",
      data: "0x",
    });
    expect(LEDGER_DRIVER.display(create, planEvm(create, EVM_KEY), pin)).toBe("blind");
    const eip7702 = evmTxRequest({
      type: "eip7702",
      chainId: 1,
      nonce: 0,
      gas: "0x5208",
      maxFeePerGas: "0x77359400",
      maxPriorityFeePerGas: "0x3b9aca00",
      value: "0xde0b6b3a7640000",
      data: "0x",
      to: "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae",
      accessList: [],
      authorization: { address: "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae" },
    });
    expect(LEDGER_DRIVER.display(eip7702, planEvm(eip7702, EVM_KEY), pin)).toBe("unsupported");
  });

  it("clears personal messages and blinds typed data", () => {
    const personal: Extract<ChainSignRequest, { kind: "evm.personal-message" }> = {
      kind: "evm.personal-message",
      network: "eip155:1",
      account: hd("evm.bip44"),
      message: utf8ToBytes("hello"),
    };
    expect(LEDGER_DRIVER.display(personal, planEvm(personal, EVM_KEY), pin)).toBe("clear");
    const typed: Extract<ChainSignRequest, { kind: "evm.typed-data" }> = {
      kind: "evm.typed-data",
      network: "eip155:1",
      account: hd("evm.bip44"),
      typedData: JSON.stringify({
        types: {
          EIP712Domain: [{ name: "name", type: "string" }],
          Mail: [{ name: "x", type: "string" }],
        },
        primaryType: "Mail",
        domain: { name: "d" },
        message: { x: "y" },
      }),
    };
    expect(LEDGER_DRIVER.display(typed, planEvm(typed, EVM_KEY), pin)).toBe("blind");
  });

  it("clears a plain tron transfer and blinds a memo", () => {
    const rawData = unhex((vectorCase("tron", "tx-transfer").call as { rawData: string }).rawData);
    const request: Extract<ChainSignRequest, { kind: "tron.transaction" }> = {
      kind: "tron.transaction",
      network: "tron:mainnet",
      account: hd("tron.bip44"),
      rawData,
    };
    expect(LEDGER_DRIVER.display(request, planTron(request, TRX_KEY), pin)).toBe("clear");
    const trc20 = unhex((vectorCase("tron", "tx-trc20").call as { rawData: string }).rawData);
    const trc20Request = { ...request, rawData: trc20 };
    expect(LEDGER_DRIVER.display(trc20Request, planTron(trc20Request, TRX_KEY), pin)).toBe("clear");
    // A TriggerSmartContract whose selector is not a TRC20 call needs "Custom contracts".
    const trc20Hex = (vectorCase("tron", "tx-trc20").call as { rawData: string }).rawData;
    const selectorAt = trc20Hex.indexOf("a9059cbb");
    expect(selectorAt).not.toBe(-1);
    const blind = {
      ...request,
      rawData: unhex(`${trc20Hex.slice(0, selectorAt)}ab${trc20Hex.slice(selectorAt + 2)}`),
    };
    expect(LEDGER_DRIVER.display(blind, planTron(blind, TRX_KEY), pin)).toBe("blind");
    // The same TRC20 call carrying TRX value is never clear — field 3 `call_value` inserted
    // before the data field 4 (all three enclosing lengths bumped by two).
    const trc20Bytes = unhex(trc20Hex);
    const withValue = new Uint8Array(trc20Bytes.length + 2);
    withValue.set(trc20Bytes.subarray(0, selectorAt / 2 - 2));
    withValue.set(Uint8Array.of(0x18, 0x01), selectorAt / 2 - 2);
    withValue.set(trc20Bytes.subarray(selectorAt / 2 - 2), selectorAt / 2);
    withValue[22] = 0xb0;
    withValue[27] = 0xab;
    withValue[81] = 0x76;
    const moved = { ...request, rawData: withValue };
    expect(LEDGER_DRIVER.display(moved, planTron(moved, TRX_KEY), pin)).toBe("blind");
    // And field 5 `call_token_value` right after the data field — a TRC10-moved call is not clear.
    const withTokenValue = new Uint8Array(trc20Bytes.length + 2);
    withTokenValue.set(trc20Bytes.subarray(0, selectorAt / 2 + 68));
    withTokenValue.set(Uint8Array.of(0x28, 0x01), selectorAt / 2 + 68);
    withTokenValue.set(trc20Bytes.subarray(selectorAt / 2 + 68), selectorAt / 2 + 70);
    withTokenValue[22] = 0xb0;
    withTokenValue[27] = 0xab;
    withTokenValue[81] = 0x76;
    const movedToken = { ...request, rawData: withTokenValue };
    expect(LEDGER_DRIVER.display(movedToken, planTron(movedToken, TRX_KEY), pin)).toBe("blind");
    // A contract without a dedicated screen (ClearABIContract, enum 48) signs by hash.
    const hashed = { ...request, rawData: renameContract(rawData, 0x30, "ClearABIContract") };
    expect(LEDGER_DRIVER.display(hashed, planTron(hashed, TRX_KEY), pin)).toBe("blind");
    // A personal message is hash-signed behind "Blind signing" — never clear.
    const message: Extract<ChainSignRequest, { kind: "tron.message" }> = {
      kind: "tron.message",
      network: "tron:mainnet",
      account: hd("tron.bip44"),
      message: utf8ToBytes("hello tron"),
    };
    expect(LEDGER_DRIVER.display(message, planTron(message, TRX_KEY), pin)).toBe("blind");
  });

  it("clears a solana system transfer and blinds an unknown program", () => {
    const message = unhex((vectorCase("solana", "tx-legacy").call as { message: string }).message);
    const request: Extract<ChainSignRequest, { kind: "solana.transaction" }> = {
      kind: "solana.transaction",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      account: hd("solana.bip44-change"),
      message,
    };
    const key: TaskKey = { path: SOL_PATH, publicKey: new Uint8Array(32) };
    expect(LEDGER_DRIVER.display(request, planSolana(request, key), pin)).toBe("clear");
    // A ComputeBudget instruction alongside the transfer stays clear.
    const budgetMessage = unhex(
      "01000104c45a24a9739accab4e759af91435a89ae9b78e6f145b0ac6786df0423438c524" +
        "0505050505050505050505050505050505050505050505050505050505050505" +
        "0000000000000000000000000000000000000000000000000000000000000000" +
        "0306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a40000000" +
        "0303030303030303030303030303030303030303030303030303030303030303" +
        "0203000502a0860100020200010c02000000e8030000e8030000",
    );
    const budget = { ...request, message: budgetMessage };
    expect(LEDGER_DRIVER.display(budget, planSolana(budget, key), pin)).toBe("clear");
    const blind = {
      ...request,
      message: unhex(
        (vectorCase("solana", "tx-unknown-blind-off").call as { message: string }).message,
      ),
    };
    expect(LEDGER_DRIVER.display(blind, planSolana(blind, key), pin)).toBe("blind");
  });

  it("admits the off-chain message formats it can show", () => {
    const key: TaskKey = { path: SOL_PATH, publicKey: new Uint8Array(32) };
    const offchain = (format: number, app: string, text: string): Uint8Array => {
      const appBytes = utf8ToBytes(app.padEnd(32, "\0"));
      const signer = publicKeyAt(ETH_PATH).subarray(1, 33);
      const msg = utf8ToBytes(text);
      const out = new Uint8Array(16 + 1 + 32 + 1 + 1 + 32 + 2 + msg.length);
      out[0] = 0xff;
      out.set(utf8ToBytes("solana offchain"), 1);
      out[16] = 0;
      out.set(appBytes, 17);
      out[49] = format;
      out[50] = 1;
      out.set(signer, 51);
      new DataView(out.buffer).setUint16(83, msg.length, true);
      out.set(msg, 85);
      return out;
    };
    const ascii: Extract<ChainSignRequest, { kind: "solana.message" }> = {
      kind: "solana.message",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      account: hd("solana.bip44-change"),
      message: offchain(0, "app", "hello ledger"),
      format: "raw",
    };
    expect(LEDGER_DRIVER.display(ascii, planSolana(ascii, key), pin)).toBe("clear");
    const utf8 = { ...ascii, message: offchain(1, "app", "héllo") };
    expect(LEDGER_DRIVER.display(utf8, planSolana(utf8, key), pin)).toBe("blind");
    const raw = { ...ascii, message: utf8ToBytes("not an offchain document") };
    expect(LEDGER_DRIVER.display(raw, planSolana(raw, key), pin)).toBe("unsupported");
  });

  it("clears short printable bitcoin messages and refuses bip322", () => {
    const messagePlan = (request: Extract<ChainSignRequest, { kind: "bitcoin.message" }>) =>
      planBitcoinMessage(
        {
          network: request.network,
          address: request.address,
          message: request.message,
          format: "legacy",
        },
        { path: BTC_MSG_PATH, publicKey: publicKeyAt(BTC_MSG_PATH) },
      );
    const base = {
      kind: "bitcoin.message" as const,
      network: "bip122:000000000019d6689c085ae165831e93",
      account: hd("btc.bip44"),
      address: BTC_MSG_ADDRESS,
      format: "legacy" as const,
      change: 0 as const,
      index: 0,
    };
    const ascii = { ...base, message: "hello ledger" };
    expect(LEDGER_DRIVER.display(ascii, messagePlan(ascii), pin)).toBe("clear");
    // The planner caps messages at 252 bytes; the display still bounds what it claims clear —
    // test the bound directly with a synthetic stage.
    const long = { ...base, message: "x".repeat(641) };
    const stage = messagePlan(ascii);
    expect(LEDGER_DRIVER.display(long, stage, pin)).toBe("blind");
    const control = { ...base, message: "bell\u0007ring" };
    expect(LEDGER_DRIVER.display(control, messagePlan(control), pin)).toBe("blind");
    const bip322 = { ...ascii, format: "bip322-simple" as const };
    expect(LEDGER_DRIVER.display(bip322, messagePlan(ascii), pin)).toBe("unsupported");
    // The pinned app is the mainnet build — a testnet request is unservable.
    const testnet = { ...ascii, network: "bip122:00000000da84f2bafbbc53dee25a72ae" };
    expect(LEDGER_DRIVER.display(testnet, messagePlan(ascii), pin)).toBe("unsupported");
  });

  it("clears a single-template psbt and refuses mixed templates", () => {
    const psbt = unhex((vectorCase("bitcoin", "sign-psbt-wpkh").call as { psbt: string }).psbt);
    const request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }> = {
      kind: "bitcoin.psbt",
      origin: "internal",
      network: "bip122:000000000019d6689c085ae165831e93",
      account: hd("btc.bip84"),
      psbt,
      sign: [{ index: 0, template: "btc.bip84" }],
    };
    const stage = planBitcoinPsbt(psbt, [{ index: 0, key: BTC84_KEY }]);
    expect(LEDGER_DRIVER.display(request, stage, pin)).toBe("clear");
    const mixed = {
      ...request,
      sign: [
        { index: 0, template: "btc.bip84" as const },
        { index: 1, template: "btc.bip49" as const },
      ],
    };
    expect(LEDGER_DRIVER.display(mixed, stage, pin)).toBe("unsupported");
    const testnet = { ...request, network: "bip122:00000000da84f2bafbbc53dee25a72ae" };
    expect(LEDGER_DRIVER.display(testnet, stage, pin)).toBe("unsupported");
  });
});

describe("ledger driver sign", () => {
  it("signs a personal message over the recorded transcript", async () => {
    const request: Extract<ChainSignRequest, { kind: "evm.personal-message" }> = {
      kind: "evm.personal-message",
      network: "eip155:1",
      account: hd("evm.bip44"),
      message: unhex("68656c6c6f20776f726c64"),
    };
    const stage = planEvm(request, EVM_KEY);
    const fake = scriptedLedger("ethereum", caseSteps("ethereum", "personal-short"));
    const out = await LEDGER_DRIVER.sign(fake.link, signContext(request, stage));
    expect(out.map(hex)).toStrictEqual([vectorCase("ethereum", "personal-short").result]);
    fake.done();
  });

  it("signs a legacy evm transaction over the recorded transcript", async () => {
    const request = evmTxRequest(LEGACY_TX);
    const stage = planEvm(request, EVM_KEY);
    const fake = scriptedLedger("ethereum", caseSteps("ethereum", "tx-legacy"));
    const out = await LEDGER_DRIVER.sign(fake.link, signContext(request, stage));
    expect(out.map(hex)).toStrictEqual([vectorCase("ethereum", "tx-legacy").result]);
    fake.done();
  });

  it("fails a stage whose digest is not the recomputed preimage", async () => {
    const request = evmTxRequest(LEGACY_TX);
    const stage = planEvm(evmTxRequest({ ...LEGACY_TX, nonce: 1 }), EVM_KEY);
    const fake = scriptedLedger("ethereum", []);
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage))),
    ).resolves.toBe("integrity");
  });

  it("fails a stage whose kind is not the request's", async () => {
    const request = evmTxRequest(LEGACY_TX);
    const personal: Extract<ChainSignRequest, { kind: "evm.personal-message" }> = {
      kind: "evm.personal-message",
      network: "eip155:1",
      account: hd("evm.bip44"),
      message: unhex("68656c6c6f20776f726c64"),
    };
    const stage = planEvm(personal, EVM_KEY);
    const fake = scriptedLedger("ethereum", []);
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage))),
    ).resolves.toBe("integrity");
  });

  it("fails a solana request handed a bitcoin stage, and vice versa", async () => {
    const message = unhex((vectorCase("solana", "tx-legacy").call as { message: string }).message);
    const solanaRequest: Extract<ChainSignRequest, { kind: "solana.transaction" }> = {
      kind: "solana.transaction",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      account: hd("solana.bip44-change"),
      message,
    };
    const psbt = unhex((vectorCase("bitcoin", "sign-psbt-wpkh").call as { psbt: string }).psbt);
    const psbtStage = planBitcoinPsbt(psbt, [{ index: 0, key: BTC84_KEY }]);
    await expect(
      code(async () =>
        LEDGER_DRIVER.sign(
          scriptedLedger("bitcoin", []).link,
          signContext(solanaRequest, psbtStage),
        ),
      ),
    ).resolves.toBe("integrity");
    const solanaStage = planSolana(solanaRequest, {
      path: SOL_PATH,
      publicKey: new Uint8Array(32),
    });
    await expect(
      code(async () =>
        LEDGER_DRIVER.sign(
          scriptedLedger("solana", []).link,
          signContext(evmTxRequest(LEGACY_TX), solanaStage),
        ),
      ),
    ).resolves.toBe("integrity");
  });

  it("refuses a blind evm transaction when the device blind setting is off", async () => {
    const request = evmTxRequest({ ...LEGACY_TX, data: "0x1234" });
    const stage = planEvm(request, EVM_KEY);
    const fake = scriptedLedger("ethereum", caseSteps("ethereum", "configuration"));
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage))),
    ).resolves.toBe("blind-signing-disabled");
    fake.done();
  });

  it("treats contract creation as blind even without calldata", async () => {
    const create = evmTxRequest({
      type: "legacy",
      chainId: 1,
      nonce: 0,
      gas: "0x5208",
      gasPrice: "0x77359400",
      value: "0xde0b6b3a7640000",
      data: "0x",
    });
    const stage = planEvm(create, EVM_KEY);
    const fake = scriptedLedger("ethereum", caseSteps("ethereum", "configuration"));
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(create, stage))),
    ).resolves.toBe("blind-signing-disabled");
    fake.done();
  });

  it("computes the fiat24 session digest from the session fields", async () => {
    const request: Extract<ChainSignRequest, { kind: "evm.fiat24-session" }> = {
      kind: "evm.fiat24-session",
      network: "eip155:1",
      account: hd("evm.bip44"),
      tokenId: "42",
      deadline: 1_700_000_000,
    };
    const stage = planEvm(request, EVM_KEY);
    // The digest check passing means the sign APDU is next — the fake has no script for it.
    const fake = scriptedLedger("ethereum", []);
    await expect(LEDGER_DRIVER.sign(fake.link, signContext(request, stage))).rejects.toThrow(
      "unscripted APDU",
    );
  });

  it("signs a tron transfer over the recorded transcript", async () => {
    const request: Extract<ChainSignRequest, { kind: "tron.transaction" }> = {
      kind: "tron.transaction",
      network: "tron:mainnet",
      account: hd("tron.bip44"),
      rawData: unhex((vectorCase("tron", "tx-transfer").call as { rawData: string }).rawData),
    };
    const stage = planTron(request, TRX_KEY);
    const fake = scriptedLedger("tron", caseSteps("tron", "tx-transfer"));
    const out = await LEDGER_DRIVER.sign(fake.link, signContext(request, stage));
    expect(out.map(hex)).toStrictEqual([vectorCase("tron", "tx-transfer").result]);
    fake.done();
  });

  it("signs a tron message only when the app allows hash signing", async () => {
    const request: Extract<ChainSignRequest, { kind: "tron.message" }> = {
      kind: "tron.message",
      network: "tron:mainnet",
      account: hd("tron.bip44"),
      message: utf8ToBytes("hello tron"),
    };
    const stage = planTron(request, TRX_KEY);
    // flags bit 3 = sign by hash (handlers/get_app_configuration.c CONFIG_BIT_SIGN_BY_HASH).
    const on = scriptedLedger("tron", [
      { response: "080008029000" },
      ...caseSteps("tron", "personal-short"),
    ]);
    const out = await LEDGER_DRIVER.sign(on.link, signContext(request, stage));
    expect(out.map(hex)).toStrictEqual([vectorCase("tron", "personal-short").result]);
    on.done();
    const off = scriptedLedger("tron", [{ response: "000008029000" }]);
    await expect(
      code(async () => LEDGER_DRIVER.sign(off.link, signContext(request, stage))),
    ).resolves.toBe("blind-signing-disabled");
    off.done();
  });

  it("refuses a tron memo and a non-TRC20 call when the device settings are off", async () => {
    const rawData = unhex((vectorCase("tron", "tx-transfer").call as { rawData: string }).rawData);
    // Insert the memo field (field 10, before the contract field 11 at offset 21).
    const memo = Uint8Array.of(0x52, 0x04, 0xaa, 0xbb, 0xcc, 0xdd);
    const withMemo = new Uint8Array(rawData.length + memo.length);
    withMemo.set(rawData.subarray(0, 21));
    withMemo.set(memo, 21);
    withMemo.set(rawData.subarray(21), 27);
    const memoRequest: Extract<ChainSignRequest, { kind: "tron.transaction" }> = {
      kind: "tron.transaction",
      network: "tron:mainnet",
      account: hd("tron.bip44"),
      rawData: withMemo,
    };
    // `flags major minor patch` — flags 0x00 means every setting is off (get_app_configuration.c).
    const configOff = [{ response: "000008029000" }];
    await expect(
      code(async () =>
        LEDGER_DRIVER.sign(
          scriptedLedger("tron", configOff).link,
          signContext(memoRequest, planTron(memoRequest, TRX_KEY)),
        ),
      ),
    ).resolves.toBe("blind-signing-disabled");
    // A TriggerSmartContract whose selector is not a TRC20 call needs "Custom contracts".
    const trc20Hex = (vectorCase("tron", "tx-trc20").call as { rawData: string }).rawData;
    const selectorAt = trc20Hex.indexOf("a9059cbb");
    const contractRequest = {
      ...memoRequest,
      rawData: unhex(`${trc20Hex.slice(0, selectorAt)}ab${trc20Hex.slice(selectorAt + 2)}`),
    };
    await expect(
      code(async () =>
        LEDGER_DRIVER.sign(
          scriptedLedger("tron", configOff).link,
          signContext(contractRequest, planTron(contractRequest, TRX_KEY)),
        ),
      ),
    ).resolves.toBe("blind-signing-disabled");
    // A contract without a dedicated screen needs "Sign by hash".
    const hashRequest = {
      ...memoRequest,
      rawData: renameContract(rawData, 0x30, "ClearABIContract"),
    };
    await expect(
      code(async () =>
        LEDGER_DRIVER.sign(
          scriptedLedger("tron", configOff).link,
          signContext(hashRequest, planTron(hashRequest, TRX_KEY)),
        ),
      ),
    ).resolves.toBe("blind-signing-disabled");
  });

  it("signs a solana transaction over the recorded transcript", async () => {
    const message = unhex((vectorCase("solana", "tx-legacy").call as { message: string }).message);
    const request: Extract<ChainSignRequest, { kind: "solana.transaction" }> = {
      kind: "solana.transaction",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      account: hd("solana.bip44-change"),
      message,
    };
    const solPin: HardwarePin = {
      ...pin,
      ed25519: [{ path: SOL_PATH, publicKey: ed25519KeyAt(SOL_PATH) }],
    };
    const key: TaskKey = { path: SOL_PATH, publicKey: ed25519KeyAt(SOL_PATH) };
    const stage = planSolana(request, key);
    const fake = scriptedLedger("solana", caseSteps("solana", "tx-legacy").slice(1));
    const out = await LEDGER_DRIVER.sign(fake.link, signContext(request, stage, solPin));
    expect(out.map(hex)).toStrictEqual([vectorCase("solana", "tx-legacy").result]);
    fake.done();
  });

  it("refuses a blind solana transaction when the device setting is off", async () => {
    const message = unhex(
      (vectorCase("solana", "tx-unknown-blind-off").call as { message: string }).message,
    );
    const request: Extract<ChainSignRequest, { kind: "solana.transaction" }> = {
      kind: "solana.transaction",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      account: hd("solana.bip44-change"),
      message,
    };
    const key: TaskKey = { path: SOL_PATH, publicKey: new Uint8Array(32) };
    const stage = planSolana(request, key);
    // The configuration reply recorded with blind signing off — the driver must stop there and
    // never send the sign request.
    const fake = scriptedLedger("solana", [{ response: "00000110009000" }]);
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage))),
    ).resolves.toBe("blind-signing-disabled");
  });

  it("refuses a solana message that is not an off-chain document", async () => {
    const request: Extract<ChainSignRequest, { kind: "solana.message" }> = {
      kind: "solana.message",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      account: hd("solana.bip44-change"),
      message: utf8ToBytes("not an offchain document"),
      format: "raw",
    };
    const key: TaskKey = { path: SOL_PATH, publicKey: new Uint8Array(32) };
    const stage = planSolana(request, key);
    const fake = scriptedLedger("solana", []);
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage))),
    ).resolves.toBe("integrity");
  });

  it("refuses an eip7702 transaction at sign time", async () => {
    const request = evmTxRequest({
      type: "eip7702",
      chainId: 1,
      nonce: 0,
      gas: "0x5208",
      maxFeePerGas: "0x77359400",
      maxPriorityFeePerGas: "0x3b9aca00",
      value: "0xde0b6b3a7640000",
      data: "0x",
      to: "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae",
      accessList: [],
      authorization: { address: "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae" },
    });
    const stage = planEvm(request, EVM_KEY);
    const fake = scriptedLedger("ethereum", []);
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage))),
    ).resolves.toBe("integrity");
  });

  it("refuses a utf8 off-chain message when the device blind setting is off", async () => {
    const appBytes = utf8ToBytes("app".padEnd(32, "\0"));
    const body = utf8ToBytes("héllo");
    const message = new Uint8Array(85 + body.length);
    message[0] = 0xff;
    message.set(utf8ToBytes("solana offchain"), 1);
    message[16] = 0;
    message.set(appBytes, 17);
    message[49] = 1;
    message[50] = 1;
    message.set(publicKeyAt(ETH_PATH).subarray(1, 33), 51);
    new DataView(message.buffer).setUint16(83, body.length, true);
    message.set(body, 85);
    const request: Extract<ChainSignRequest, { kind: "solana.message" }> = {
      kind: "solana.message",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      account: hd("solana.bip44-change"),
      message,
      format: "raw",
    };
    const key: TaskKey = { path: SOL_PATH, publicKey: new Uint8Array(32) };
    const stage = planSolana(request, key);
    const fake = scriptedLedger("solana", [{ response: "00000110009000" }]);
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage))),
    ).resolves.toBe("blind-signing-disabled");
  });

  it("signs a wpkh psbt and maps the yielded signature", async () => {
    const psbt = unhex((vectorCase("bitcoin", "sign-psbt-wpkh").call as { psbt: string }).psbt);
    const request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }> = {
      kind: "bitcoin.psbt",
      origin: "internal",
      network: "bip122:000000000019d6689c085ae165831e93",
      account: hd("btc.bip84"),
      psbt,
      sign: [{ index: 0, template: "btc.bip84" }],
    };
    const stage = planBitcoinPsbt(psbt, [{ index: 0, key: BTC84_KEY }]);
    const fake = scriptedLedger("bitcoin", caseSteps("bitcoin", "sign-psbt-wpkh").slice(1));
    const out = await LEDGER_DRIVER.sign(fake.link, signContext(request, stage));
    expect(out).toHaveLength(1);
    const yields = vectorCase("bitcoin", "sign-psbt-wpkh").result as ReadonlyArray<{
      signature: string;
    }>;
    expect(out.map((bytes) => bytes.length)).toStrictEqual([64]);
    fake.done();
    expect(yields.map((y) => y.signature.startsWith("30"))).toStrictEqual([true]);
  });

  it("sends the device a PSBT without the far-change derivation the kernel shows", async () => {
    /* app-bitcoin-new hides as change every output carrying the wallet's derivation on the policy's
       change chain, with no index bound — while the kernel only hides discoverable change and
       shows e.g. m/84'/0'/0'/1/5000 by address. The driver strips the wallet's derivation pairs
       from every output the kernel did not hide, so the device displays the same rows. */
    const { fingerprint } = HDKey.fromMasterSeed(SEED);
    const pathAt = (index: number): KeyPath => [H + 84, H, H, 1, index];
    const spendPub = BTC84_KEY.publicKey;
    const changePub = publicKeyAt(pathAt(0));
    const farPub = publicKeyAt(pathAt(5000));
    const tx = new Transaction({
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    });
    tx.addInput({
      txid: "11".repeat(32),
      index: 0,
      witnessUtxo: { script: p2wpkh(spendPub).script, amount: 10_000n },
      bip32Derivation: [[spendPub, { fingerprint, path: [H + 84, H, H, 0, 0] }]],
    });
    tx.addOutput({
      script: p2wpkh(changePub).script,
      amount: 4000n,
      bip32Derivation: [[changePub, { fingerprint, path: [...pathAt(0)] }]],
    });
    tx.addOutput({
      script: p2wpkh(farPub).script,
      amount: 3000n,
      bip32Derivation: [[farPub, { fingerprint, path: [...pathAt(5000)] }]],
    });
    const psbt = tx.toPSBT(2);
    const request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }> = {
      kind: "bitcoin.psbt",
      origin: "internal",
      network: "bip122:000000000019d6689c085ae165831e93",
      account: hd("btc.bip84"),
      psbt,
      sign: [{ index: 0, template: "btc.bip84" }],
    };
    const hiddenChange = new Set([hex(p2wpkh(changePub).script)]);
    const stage = { ...planBitcoinPsbt(psbt, [{ index: 0, key: BTC84_KEY }]), hiddenChange };
    const DER = secp256k1.Signature.fromBytes(
      secp256k1.sign(sha256(new Uint8Array(32).fill(7)), new Uint8Array(32).fill(9)),
    ).toBytes("der");
    const yielded = Uint8Array.of(0, spendPub.length, ...spendPub, ...DER, 0x01);
    const fake = scriptedLedger("bitcoin", [
      { response: `10${hex(yielded)}e000` },
      { response: "9000" },
    ]);
    const out = await LEDGER_DRIVER.sign(fake.link, signContext(request, stage));
    expect(out).toHaveLength(1);
    fake.done();
    /* The SIGN_PSBT APDU (sent[0] is the app-version exchange) commits the stripped output maps —
       the hidden change keeps its pairs, the far change carries none. */
    const strippedRoot = merkleRoot(
      psbtV2Maps(stripUnhiddenDerivations(psbt, hiddenChange, FINGERPRINT)).outputs.map((map) =>
        leafHash(mapCommitment(map)),
      ),
    );
    const rawRoot = merkleRoot(psbtV2Maps(psbt).outputs.map((map) => leafHash(mapCommitment(map))));
    const signPsbtApdu = fake.sent[1] ?? "";
    expect(signPsbtApdu).toContain(hex(strippedRoot));
    expect(signPsbtApdu).not.toContain(hex(rawRoot));
  });

  it("refuses a mismatched solana stage message", async () => {
    const message = unhex((vectorCase("solana", "tx-legacy").call as { message: string }).message);
    const request: Extract<ChainSignRequest, { kind: "solana.transaction" }> = {
      kind: "solana.transaction",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      account: hd("solana.bip44-change"),
      message,
    };
    const key: TaskKey = { path: SOL_PATH, publicKey: new Uint8Array(32) };
    const stage = planSolana({ ...request, message: Uint8Array.of(1, 2, 3) }, key);
    const fake = scriptedLedger("solana", []);
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage))),
    ).resolves.toBe("integrity");
  });

  it("refuses evm typed data when the device blind setting is off", async () => {
    const typed: Extract<ChainSignRequest, { kind: "evm.typed-data" }> = {
      kind: "evm.typed-data",
      network: "eip155:1",
      account: hd("evm.bip44"),
      typedData: JSON.stringify({
        types: {
          EIP712Domain: [{ name: "name", type: "string" }],
          Mail: [{ name: "x", type: "string" }],
        },
        primaryType: "Mail",
        domain: { name: "d" },
        message: { x: "y" },
      }),
    };
    const stage = planEvm(typed, EVM_KEY);
    const fake = scriptedLedger("ethereum", caseSteps("ethereum", "configuration"));
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(typed, stage))),
    ).resolves.toBe("blind-signing-disabled");
  });

  it("refuses tron typed data when sign by hash is off", async () => {
    const typed: Extract<ChainSignRequest, { kind: "tron.typed-data" }> = {
      kind: "tron.typed-data",
      network: "tron:728126428",
      account: hd("tron.bip44"),
      typedData: JSON.stringify({
        types: {
          EIP712Domain: [{ name: "name", type: "string" }],
          Mail: [{ name: "x", type: "string" }],
        },
        primaryType: "Mail",
        domain: { name: "d" },
        message: { x: "y" },
      }),
    };
    const stage = planTron(typed, TRX_KEY);
    // `flags major minor patch` — flags 0x00 means sign by hash off (handlers/get_app_configuration.c).
    const fake = scriptedLedger("tron", [{ response: "000008029000" }]);
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(typed, stage))),
    ).resolves.toBe("blind-signing-disabled");
  });

  it("signs a legacy bitcoin message and returns r‖s", async () => {
    const key = { path: BTC_MSG_PATH, publicKey: publicKeyAt(BTC_MSG_PATH) };
    const request: Extract<ChainSignRequest, { kind: "bitcoin.message" }> = {
      kind: "bitcoin.message",
      network: "bip122:000000000019d6689c085ae165831e93",
      account: hd("btc.bip44"),
      address: BTC_MSG_ADDRESS,
      message: "Hello Ledger Bitcoin!",
      format: "legacy",
      change: 0,
      index: 0,
    };
    const stage = planBitcoinMessage(request, key);
    const fake = scriptedLedger("bitcoin", caseSteps("bitcoin", "sign-message"));
    const out = await LEDGER_DRIVER.sign(fake.link, signContext(request, stage));
    const recorded = vectorCase("bitcoin", "sign-message").result as { signature: string };
    expect(out.map(hex)).toStrictEqual([recorded.signature]);
    fake.done();
  });

  it("integrity-checks a psbt yield that is not in the plan", async () => {
    const psbt = unhex((vectorCase("bitcoin", "sign-psbt-wpkh").call as { psbt: string }).psbt);
    const request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }> = {
      kind: "bitcoin.psbt",
      origin: "internal",
      network: "bip122:000000000019d6689c085ae165831e93",
      account: hd("btc.bip84"),
      psbt,
      sign: [{ index: 0, template: "btc.bip84" }],
    };
    // The plan is valid, but the task names a different key than the device will yield.
    const planned = planBitcoinPsbt(psbt, [{ index: 0, key: BTC84_KEY }]);
    const stage = {
      ...planned,
      tasks: planned.tasks.map((t) => ({
        ...t,
        publicKey: publicKeyAt([H + 84, H, H, 0, 1]),
      })),
    };
    const fake = scriptedLedger("bitcoin", caseSteps("bitcoin", "sign-psbt-wpkh").slice(1));
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage))),
    ).resolves.toBe("integrity");
  });

  it("integrity-checks a psbt yield that is missing for a planned input", async () => {
    const psbt = unhex((vectorCase("bitcoin", "sign-psbt-wpkh").call as { psbt: string }).psbt);
    const request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }> = {
      kind: "bitcoin.psbt",
      origin: "internal",
      network: "bip122:000000000019d6689c085ae165831e93",
      account: hd("btc.bip84"),
      psbt,
      sign: [{ index: 0, template: "btc.bip84" }],
    };
    const planned = planBitcoinPsbt(psbt, [{ index: 0, key: BTC84_KEY }]);
    const stage = {
      ...planned,
      inputs: planned.inputs.map((i) => ({ ...i, index: 5 })),
    };
    const fake = scriptedLedger("bitcoin", caseSteps("bitcoin", "sign-psbt-wpkh").slice(1));
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage))),
    ).resolves.toBe("integrity");
  });

  it("signs a taproot psbt and maps the yielded signature", async () => {
    const trPin: HardwarePin = { ...pin, nodes: [nodeAt(SEED, ACCOUNT_86)] };
    const psbt = unhex((vectorCase("bitcoin", "sign-psbt-tr").call as { psbt: string }).psbt);
    const request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }> = {
      kind: "bitcoin.psbt",
      origin: "internal",
      network: "bip122:000000000019d6689c085ae165831e93",
      account: hd("btc.bip86"),
      psbt,
      sign: [{ index: 0, template: "btc.bip86" }],
    };
    const stage = planBitcoinPsbt(psbt, [{ index: 0, key: BTC86_KEY }]);
    const fake = scriptedLedger("bitcoin", caseSteps("bitcoin", "sign-psbt-tr").slice(1));
    const out = await LEDGER_DRIVER.sign(fake.link, signContext(request, stage, trPin));
    const [yield_] = vectorCase("bitcoin", "sign-psbt-tr").result as ReadonlyArray<{
      signature: string;
    }>;
    expect(out.map(hex)).toStrictEqual([yield_?.signature]);
    fake.done();
  });

  it("integrity-checks a taproot yield whose output key is not the task's", async () => {
    const trPin: HardwarePin = { ...pin, nodes: [nodeAt(SEED, ACCOUNT_86)] };
    const psbt = unhex((vectorCase("bitcoin", "sign-psbt-tr").call as { psbt: string }).psbt);
    const request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }> = {
      kind: "bitcoin.psbt",
      origin: "internal",
      network: "bip122:000000000019d6689c085ae165831e93",
      account: hd("btc.bip86"),
      psbt,
      sign: [{ index: 0, template: "btc.bip86" }],
    };
    const planned = planBitcoinPsbt(psbt, [{ index: 0, key: BTC86_KEY }]);
    const stage = {
      ...planned,
      tasks: planned.tasks.map((t) => ({
        ...t,
        publicKey: publicKeyAt([H + 86, H, H, 0, 1]).subarray(1),
      })),
    };
    const fake = scriptedLedger("bitcoin", caseSteps("bitcoin", "sign-psbt-tr").slice(1));
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage, trPin))),
    ).resolves.toBe("integrity");
  });

  it("integrity-checks a taproot yield whose sighash byte is not the plan's", async () => {
    const trPin: HardwarePin = { ...pin, nodes: [nodeAt(SEED, ACCOUNT_86)] };
    const psbt = unhex((vectorCase("bitcoin", "sign-psbt-tr").call as { psbt: string }).psbt);
    const request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }> = {
      kind: "bitcoin.psbt",
      origin: "internal",
      network: "bip122:000000000019d6689c085ae165831e93",
      account: hd("btc.bip86"),
      psbt,
      sign: [{ index: 0, template: "btc.bip86" }],
    };
    const planned = planBitcoinPsbt(psbt, [{ index: 0, key: BTC86_KEY }]);
    const stage = {
      ...planned,
      inputs: planned.inputs.map((i) => ({ ...i, sighash: 0x81 })),
    };
    // Extend the yielded 64-byte signature with a trailing 0x01 — the plan asked for 0x81.
    const steps = extendYieldedSig(caseSteps("bitcoin", "sign-psbt-tr").slice(1));
    const fake = scriptedLedger("bitcoin", steps);
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage, trPin))),
    ).resolves.toBe("integrity");
  });

  it("integrity-checks a taproot yield whose length is not the plan's sighash", async () => {
    const trPin: HardwarePin = { ...pin, nodes: [nodeAt(SEED, ACCOUNT_86)] };
    const psbt = unhex((vectorCase("bitcoin", "sign-psbt-tr").call as { psbt: string }).psbt);
    const request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }> = {
      kind: "bitcoin.psbt",
      origin: "internal",
      network: "bip122:000000000019d6689c085ae165831e93",
      account: hd("btc.bip86"),
      psbt,
      sign: [{ index: 0, template: "btc.bip86" }],
    };
    const planned = planBitcoinPsbt(psbt, [{ index: 0, key: BTC86_KEY }]);
    const stage = {
      ...planned,
      inputs: planned.inputs.map((i) => ({ ...i, sighash: i.sighash + 1 })),
    };
    const fake = scriptedLedger("bitcoin", caseSteps("bitcoin", "sign-psbt-tr").slice(1));
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage, trPin))),
    ).resolves.toBe("integrity");
  });

  it("integrity-checks a psbt yield whose sighash byte is not the plan's", async () => {
    const psbt = unhex((vectorCase("bitcoin", "sign-psbt-wpkh").call as { psbt: string }).psbt);
    const request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }> = {
      kind: "bitcoin.psbt",
      origin: "internal",
      network: "bip122:000000000019d6689c085ae165831e93",
      account: hd("btc.bip84"),
      psbt,
      sign: [{ index: 0, template: "btc.bip84" }],
    };
    const planned = planBitcoinPsbt(psbt, [{ index: 0, key: BTC84_KEY }]);
    const stage = {
      ...planned,
      inputs: planned.inputs.map((i) => ({ ...i, sighash: i.sighash + 1 })),
    };
    const fake = scriptedLedger("bitcoin", caseSteps("bitcoin", "sign-psbt-wpkh").slice(1));
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage))),
    ).resolves.toBe("integrity");
  });

  it("refuses a mixed-template psbt at sign time too", async () => {
    const psbt = unhex((vectorCase("bitcoin", "sign-psbt-wpkh").call as { psbt: string }).psbt);
    const request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }> = {
      kind: "bitcoin.psbt",
      origin: "internal",
      network: "bip122:000000000019d6689c085ae165831e93",
      account: hd("btc.bip84"),
      psbt,
      sign: [
        { index: 0, template: "btc.bip84" },
        { index: 1, template: "btc.bip44" },
      ],
    };
    const stage = planBitcoinPsbt(psbt, [{ index: 0, key: BTC84_KEY }]);
    const fake = scriptedLedger("bitcoin", []);
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage))),
    ).resolves.toBe("integrity");
  });

  it("refuses a message stage whose task is not ecdsa", async () => {
    const request: Extract<ChainSignRequest, { kind: "bitcoin.message" }> = {
      kind: "bitcoin.message",
      network: "bip122:000000000019d6689c085ae165831e93",
      account: hd("btc.bip44"),
      address: BTC_MSG_ADDRESS,
      message: "hello ledger",
      format: "legacy",
      change: 0,
      index: 0,
    };
    const planned = planBitcoinMessage(
      {
        network: request.network,
        address: request.address,
        message: request.message,
        format: "legacy",
      },
      { path: BTC_MSG_PATH, publicKey: publicKeyAt(BTC_MSG_PATH) },
    );
    const stage = {
      ...planned,
      tasks: planned.tasks.map((t) => ({ ...t, scheme: "bip340" as const })),
    } as unknown as typeof planned;
    const fake = scriptedLedger("bitcoin", []);
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage))),
    ).resolves.toBe("integrity");
  });

  it("refuses a bip322 message stage at sign time", async () => {
    const request: Extract<ChainSignRequest, { kind: "bitcoin.message" }> = {
      kind: "bitcoin.message",
      network: "bip122:000000000019d6689c085ae165831e93",
      account: hd("btc.bip44"),
      address: BTC_MSG_ADDRESS,
      message: "hello ledger",
      format: "bip322-simple",
      change: 0,
      index: 0,
    };
    const stage = planBitcoinMessage(
      {
        network: request.network,
        address: request.address,
        message: request.message,
        format: "legacy",
      },
      { path: BTC_MSG_PATH, publicKey: publicKeyAt(BTC_MSG_PATH) },
    );
    const fake = scriptedLedger("bitcoin", []);
    await expect(
      code(async () => LEDGER_DRIVER.sign(fake.link, signContext(request, stage))),
    ).resolves.toBe("integrity");
    // And the mirror: a legacy request handed a bip322 stage.
    const legacyRequest = { ...request, format: "legacy" as const };
    await expect(
      code(async () =>
        LEDGER_DRIVER.sign(
          fake.link,
          signContext(legacyRequest, { ...stage, format: "bip322-simple" }),
        ),
      ),
    ).resolves.toBe("integrity");
  });
});

const ed25519KeyAt = (path: KeyPath): Uint8Array => edAt(SEED, path).publicKey;
