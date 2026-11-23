import { readFileSync } from "node:fs";
import { join } from "node:path";

/* oxlint-disable typescript/no-unsafe-type-assertion -- the JSON plan vectors are untyped */
/**
 * The request/plan/pin inputs the driver recorder (scripts/vectors/onekey-emulator.ts --driver) and
 * the driver replay test (tests/onekey-driver-emulator.test.ts) share, so the recorded wire
 * requests are byte-for-byte reproducible from the committed vectors. Requests come from
 * vectors/chains/signing-plans.json (the same sources the protocol sessions use); plans come from
 * the production wallet-chains plan functions — the same ones the kernel's prepare stage runs.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction as ScureTransaction } from "@scure/btc-signer/transaction.js";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";

import type { EvmTransaction, TaskKey } from "@qntx/wallet-chains";
import {
  planBitcoinMessage,
  planBitcoinPsbt,
  bitcoinAddressFromXpub,
} from "@qntx/wallet-chains/bitcoin";
import { planEvm, evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import type { EvmSignPlan } from "@qntx/wallet-chains/evm";
import { planSolana, solanaAddressFromPublicKey } from "@qntx/wallet-chains/solana";
import {
  decodeTronContract,
  decodeTronRawData,
  encodeTronContract,
  encodeTronRawData,
  planTron,
  tronAddressFromPublicKey,
} from "@qntx/wallet-chains/tron";
import type { ChainSignRequest, ChainTemplate } from "@qntx/wallet/protocol";

import type { ChainPlan } from "../../src/modules/chains/run.ts";
import type { HardwarePin } from "../../src/modules/signers/driver.ts";
import { pathToString } from "../../src/modules/signers/record.ts";
import { edAt, masterFingerprint, nodeAt } from "../signers-fake.ts";
import { buildMixedPsbt } from "./bitcoin-fixtures.ts";
import { TEST_MNEMONIC } from "./index.ts";

const H = 0x80_00_00_00;
const hex = hexToBytes;

export const DRIVER_SEED = mnemonicToSeedSync(TEST_MNEMONIC);

export const EVM_NETWORK = "eip155:1";
export const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
export const TRON_NETWORK = "tron:728126428";
export const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const ACCOUNT = (
  template: ChainTemplate,
): { kind: "hd"; walletId: string; groupIndex: number; template: ChainTemplate } => ({
  kind: "hd",
  walletId: "onekey",
  groupIndex: 0,
  template,
});

export const EVM_ACCOUNT_PATH = [44 + H, 60 + H, H];
export const TRON_ACCOUNT_PATH = [44 + H, 195 + H, H];
export const SOLANA_LEAF_PATH = [44 + H, 501 + H, H, H];

/** The material pairing pins: the six account nodes and the solana leaf, from the test seed. */
export const driverPin = (): HardwarePin => ({
  fingerprint: masterFingerprint(DRIVER_SEED),
  nodes: [
    [44 + H, H, H],
    [49 + H, H, H],
    [84 + H, H, H],
    [86 + H, H, H],
    EVM_ACCOUNT_PATH,
    TRON_ACCOUNT_PATH,
  ].map((path) => nodeAt(DRIVER_SEED, path)),
  ed25519: [edAt(DRIVER_SEED, SOLANA_LEAF_PATH)],
});

export const leafPublic = (path: number[]): Uint8Array => {
  const hd = HDKey.fromMasterSeed(DRIVER_SEED).derive(pathToString(path));
  if (hd.publicKey === null) {
    throw new Error("no public key for the leaf");
  }
  return hd.publicKey;
};

const leafKey = (path: number[]): TaskKey => ({ path, publicKey: leafPublic(path) });

const solKey = (path: number[]): TaskKey => ({
  path,
  publicKey: ed25519.getPublicKey(
    Slip10.fromMasterSeed(DRIVER_SEED).derive(pathToString(path)).privateKey,
  ),
});

export type PlanCase = {
  readonly name: string;
  readonly key: { readonly path: number[]; readonly publicKey: string };
  readonly request: {
    readonly kind?: string;
    readonly network?: string;
    readonly tx?: EvmTransaction;
    readonly message?: string;
    readonly typedData?: string;
    readonly rawData?: string;
    readonly psbt?: string;
    readonly address?: string;
    readonly format?: "legacy" | "bip322-simple";
    readonly inputs?: ReadonlyArray<{ index: number; path: number[]; publicKey: string }>;
  };
  readonly stages?: ReadonlyArray<ReadonlyArray<{ path: number[]; publicKey: string }>>;
};

const plans = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../../vectors/chains/signing-plans.json"), "utf8"),
) as { cases: PlanCase[] };

export const planCase = (name: string): PlanCase => {
  const found = plans.cases.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(`plan case ${name} missing from signing-plans.json`);
  }
  return found;
};

/** The device Solana key replaces the plan's foreign fee payer — the emulator signs only itself. */
const THEIRD_SOL = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";

const solanaSelfMessage = (name: string): Uint8Array => {
  const plan = planCase(name);
  const message = plan.request.message ?? "";
  return hex(message.replace(THEIRD_SOL, plan.key.publicKey));
};

/** Rebuild a tron raw_data with the device address as contract owner (the firmware substitutes). */
const tronSelfRaw = (name: string): Uint8Array => {
  const raw = decodeTronRawData(hex(planCase(name).request.rawData ?? ""));
  const decoded = decodeTronContract(raw.contract.typeId, raw.contract.value);
  if (decoded === undefined) {
    throw new Error("tron plan case is not decodable");
  }
  const owner = tronAddressFromPublicKey(leafPublic([...TRON_ACCOUNT_PATH, 0, 0]));
  const value = encodeTronContract({ ...decoded.contract, owner });
  return encodeTronRawData({ ...raw, contract: { ...raw.contract, value } });
};

export type DriverSignCase = {
  /** The recorded session name in driver-<model>.json. */
  readonly name: string;
  readonly request: ChainSignRequest;
  readonly stage: () => ChainPlan;
};

const evmKey = (): TaskKey => leafKey(planCase("evm-legacy").key.path);

const evmTx = (name: string): EvmTransaction => {
  const { tx } = planCase(name).request;
  if (tx === undefined) {
    throw new Error(`plan case ${name} carries no transaction`);
  }
  return tx;
};

const evmTxRequest = (plan: string): Extract<ChainSignRequest, { kind: "evm.transaction" }> => ({
  kind: "evm.transaction",
  network: EVM_NETWORK,
  account: ACCOUNT("evm.bip44"),
  tx: evmTx(plan),
});

/** The eip7702 request and its stage-1 plan; stage 2 is assembleEvm's `next` on stage 1's sig. */
export const eip7702Case = (): {
  readonly request: Extract<ChainSignRequest, { kind: "evm.transaction" }>;
  readonly stage: () => EvmSignPlan;
} => ({
  request: evmTxRequest("evm-eip7702-upgrade"),
  stage: () => planEvm(evmTxRequest("evm-eip7702-upgrade"), evmKey()),
});

export { assembleEvm } from "@qntx/wallet-chains/evm";

type BitcoinTemplate = Extract<
  ChainSignRequest,
  { kind: "bitcoin.psbt" }
>["sign"][number]["template"];

const PURPOSE_TEMPLATE: Record<number, BitcoinTemplate> = {
  44: "btc.bip44",
  49: "btc.bip49",
  84: "btc.bip84",
  86: "btc.bip86",
};

const bitcoinPsbtCase = (): DriverSignCase => {
  const item = planCase("bitcoin-psbt-every-template");
  const { psbt } = buildMixedPsbt(
    item.request.psbt ?? "",
    item.request.inputs?.[3]?.publicKey ?? "",
  );
  const [tasks] = item.stages ?? [];
  if (tasks === undefined) {
    throw new Error("bitcoin-psbt-every-template carries no stage tasks");
  }
  // The planner needs the p2sh input's redeemScript to compute its sighash (the device derives
  // it from the declared path — protocol-level signing does not require the field).
  const shKey = tasks[1]?.publicKey;
  if (shKey === undefined) {
    throw new Error("the mixed plan carries too few tasks");
  }
  const spend = ScureTransaction.fromPSBT(psbt, { allowUnknownInputs: true });
  spend.updateInput(1, { redeemScript: p2wpkh(hex(shKey)).script });
  const planned = spend.toPSBT(0);
  const request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }> = {
    kind: "bitcoin.psbt",
    network: BTC_NETWORK,
    account: { kind: "hd", walletId: "onekey", groupIndex: 0 },
    psbt: planned,
    sign: tasks.map((task, index) => {
      const template = PURPOSE_TEMPLATE[(task.path[0] ?? 0) - H];
      if (template === undefined) {
        throw new Error(`stage task ${index} has an unknown purpose`);
      }
      return { index, template };
    }),
  };
  return {
    name: "driver-sign-bitcoin-psbt",
    request,
    stage: () =>
      planBitcoinPsbt(
        planned,
        (item.request.inputs ?? []).map((input) => ({
          index: input.index,
          key: { path: input.path, publicKey: hex(input.publicKey) },
        })),
      ),
  };
};

const bitcoinMessageCase = (plan: string, name: string): DriverSignCase => {
  const item = planCase(plan);
  const format = item.request.format ?? "legacy";
  const address = item.request.address ?? "";
  const template = PURPOSE_TEMPLATE[(item.key.path[0] ?? 0) - H];
  if (template === undefined) {
    throw new Error(`${plan} has an unknown purpose`);
  }
  const request: Extract<ChainSignRequest, { kind: "bitcoin.message" }> = {
    kind: "bitcoin.message",
    network: BTC_NETWORK,
    account: ACCOUNT(template),
    address,
    message: item.request.message ?? "",
    format,
    change: 0,
    index: 0,
  };
  return {
    name,
    request,
    stage: () =>
      planBitcoinMessage(request, {
        path: item.key.path,
        publicKey: hex(item.key.publicKey),
      }),
  };
};

export const driverSignCases = (): DriverSignCase[] => {
  const solMessage = solanaSelfMessage("solana-transaction-legacy-single-signer");
  const solMessageRaw = hex(planCase("solana-message-raw").request.message ?? "");
  const tronTxRaw = tronSelfRaw("tron-transaction-trx-transfer");
  const tronMessage = hex(planCase("tron-message").request.message ?? "");
  const tronKey = leafKey(planCase("tron-message").key.path);
  const solPlan = planCase("solana-transaction-legacy-single-signer");
  const typedData = planCase("evm-typed-data-mail").request.typedData ?? "";
  const personal = new TextEncoder().encode("hello");

  const solanaTxRequest: Extract<ChainSignRequest, { kind: "solana.transaction" }> = {
    kind: "solana.transaction",
    network: SOLANA_NETWORK,
    account: ACCOUNT("solana.bip44-change"),
    message: solMessage,
  };
  const solanaMessageRequest: Extract<ChainSignRequest, { kind: "solana.message" }> = {
    kind: "solana.message",
    network: SOLANA_NETWORK,
    account: ACCOUNT("solana.bip44-change"),
    message: solMessageRaw,
    format: "raw",
  };
  const tronTxRequest: Extract<ChainSignRequest, { kind: "tron.transaction" }> = {
    kind: "tron.transaction",
    network: TRON_NETWORK,
    account: ACCOUNT("tron.bip44"),
    rawData: tronTxRaw,
  };
  const tronMessageRequest: Extract<ChainSignRequest, { kind: "tron.message" }> = {
    kind: "tron.message",
    network: TRON_NETWORK,
    account: ACCOUNT("tron.bip44"),
    message: tronMessage,
  };
  const personalRequest: Extract<ChainSignRequest, { kind: "evm.personal-message" }> = {
    kind: "evm.personal-message",
    network: EVM_NETWORK,
    account: ACCOUNT("evm.bip44"),
    message: personal,
  };
  const typedDataRequest: Extract<ChainSignRequest, { kind: "evm.typed-data" }> = {
    kind: "evm.typed-data",
    network: EVM_NETWORK,
    account: ACCOUNT("evm.bip44"),
    typedData,
  };

  return [
    ...["evm-legacy", "evm-eip1559"].map((plan): DriverSignCase => {
      const request = evmTxRequest(plan);
      return {
        name: `driver-sign-${plan}`,
        request,
        stage: () => planEvm(request, evmKey()),
      };
    }),
    {
      name: "driver-sign-evm-personal-message",
      request: personalRequest,
      stage: () => planEvm(personalRequest, evmKey()),
    },
    {
      name: "driver-sign-evm-typed-data",
      request: typedDataRequest,
      stage: () => planEvm(typedDataRequest, evmKey()),
    },
    {
      name: "driver-sign-solana-transaction",
      request: solanaTxRequest,
      stage: () => planSolana(solanaTxRequest, solKey(solPlan.key.path)),
    },
    {
      name: "driver-sign-solana-message",
      request: solanaMessageRequest,
      stage: () => planSolana(solanaMessageRequest, solKey(solPlan.key.path)),
    },
    {
      name: "driver-sign-tron-transaction",
      request: tronTxRequest,
      stage: () => planTron(tronTxRequest, tronKey),
    },
    {
      name: "driver-sign-tron-message",
      request: tronMessageRequest,
      stage: () => planTron(tronMessageRequest, tronKey),
    },
    bitcoinPsbtCase(),
    bitcoinMessageCase("bitcoin-message-legacy", "driver-sign-bitcoin-message-legacy"),
    bitcoinMessageCase(
      "bitcoin-message-bip322-p2wpkh",
      "driver-sign-bitcoin-message-bip322-p2wpkh",
    ),
    bitcoinMessageCase("bitcoin-message-bip322-p2tr", "driver-sign-bitcoin-message-bip322-p2tr"),
  ];
};

/** The gap list `accounts` fetches for a second account group. */
export const driverAccountsNeed = {
  secp256k1: [
    [44 + H, 60 + H, 1 + H],
    [84 + H, H, 1 + H],
  ] as number[][],
  ed25519: [[44 + H, 501 + H, 1 + H, H]] as number[][],
};

/** VerifyAddress targets — only the Pro emulator can run a host-initiated display headlessly. */
export const driverVerifyTargets = (): ReadonlyArray<{
  readonly name: string;
  readonly target: {
    readonly path: number[];
    readonly address: string;
    readonly template: ChainTemplate;
    readonly network: string;
  };
}> => {
  const evm = leafPublic([...EVM_ACCOUNT_PATH, 0, 0]);
  const tron = leafPublic([...TRON_ACCOUNT_PATH, 0, 0]);
  const bip84 = HDKey.fromMasterSeed(DRIVER_SEED).derive("m/84'/0'/0'").publicExtendedKey;
  const solana = ed25519.getPublicKey(
    Slip10.fromMasterSeed(DRIVER_SEED).derive(pathToString(SOLANA_LEAF_PATH)).privateKey,
  );
  return [
    {
      name: "driver-verify-evm",
      target: {
        path: [...EVM_ACCOUNT_PATH, 0, 0],
        address: evmAddressFromPublicKey(evm),
        template: "evm.bip44",
        network: EVM_NETWORK,
      },
    },
    {
      name: "driver-verify-tron",
      target: {
        path: [...TRON_ACCOUNT_PATH, 0, 0],
        address: tronAddressFromPublicKey(tron),
        template: "tron.bip44",
        network: TRON_NETWORK,
      },
    },
    {
      name: "driver-verify-bip84",
      target: {
        path: [84 + H, H, H, 0, 0],
        address: bitcoinAddressFromXpub(bip84, "btc.bip84", BTC_NETWORK, 0, 0),
        template: "btc.bip84",
        network: BTC_NETWORK,
      },
    },
    {
      name: "driver-verify-solana",
      target: {
        path: [...SOLANA_LEAF_PATH],
        address: solanaAddressFromPublicKey(solana),
        template: "solana.bip44-change",
        network: SOLANA_NETWORK,
      },
    },
  ];
};
