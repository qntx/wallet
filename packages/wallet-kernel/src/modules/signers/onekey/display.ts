/**
 * Display classification: `displayFor` computes what a device with `DeviceInfo` shows for one
 * request/plan pair — shared by `display` (the record's promised identity) and `sign` (the live
 * Features must still show what the prompt promised). `infoOf` synthesizes the DeviceInfo a paired
 * record can promise from the claim stored at pairing; a record whose model or firmware is absent
 * or unreadable returns `undefined` — the caller answers `unsupported` rather than guess.
 */
import type { ChainSignRequest, DeviceDisplay } from "@qntx/wallet/protocol";

import type { ChainPlan } from "../../chains/run.ts";
import type { DeviceIdentity, Driver } from "../driver.ts";
import { btcCoinName, psbtEntries } from "./bitcoin.ts";
import { integrity } from "./errors.ts";
import { bitcoinDisplay, evmDisplay, solanaDisplay, tronDisplay } from "./protocol/index.ts";
import type { DeviceInfo, OneKeyModel } from "./protocol/index.ts";

const MODEL: Readonly<Record<string, OneKeyModel>> = {
  classic: "classic",
  classic1s: "classic1s",
  pure: "pure",
  mini: "mini",
  touch: "touch",
  pro: "pro",
};

// Capability_EthereumTypedData (1000) — see protocol/device.ts.
const CAPABILITY_ETHEREUM_TYPED_DATA = 1000;

const atLeast = (
  firmware: readonly [number, number, number],
  version: readonly [number, number, number],
): boolean =>
  firmware[0] === version[0]
    ? firmware[1] === version[1]
      ? firmware[2] >= version[2]
      : firmware[1] > version[1]
    : firmware[0] > version[0];

/**
 * The DeviceInfo a paired record can promise: model and firmware come from the claim stored at
 * pairing; capabilities are never stored, so the classic family's typed-data stream flag is derived
 * from firmware alone — SDK `api/evm/EVMSignTypedData.ts` supportEip712OnClassic advertises
 * Capability_EthereumTypedData only on Classic 1S/Pure from 3.14.0 (classic/mini never do;
 * touch/pro stream unconditionally).
 */
const infoOf = (identity: DeviceIdentity): DeviceInfo | undefined => {
  const model = MODEL[identity.model ?? ""];
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(identity.firmware ?? "");
  if (model === undefined || match === null) {
    return undefined;
  }
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const capabilities =
    (model === "classic1s" || model === "pure") && atLeast(version, [3, 14, 0])
      ? [CAPABILITY_ETHEREUM_TYPED_DATA]
      : [];
  return {
    model,
    firmware: version,
    deviceId: "",
    capabilities,
    bitcoinOnly: false,
    pinProtection: false,
    passphraseProtection: false,
    unlocked: true,
    sessionId: undefined,
  };
};

/** Family display functions take the signing key from the plan's first task. */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
export const displayFor = (
  request: ChainSignRequest,
  stage: ChainPlan,
  info: DeviceInfo,
): DeviceDisplay | "unsupported" => {
  const [task] = stage.tasks;
  switch (stage.kind) {
    case "evm.transaction":
      if (request.kind !== "evm.transaction") {
        integrity("the request is not an evm transaction");
      }
      return evmDisplay(info, { kind: "evm.transaction", tx: request.tx });
    case "evm.personal-message":
    case "evm.fiat24-session":
      if (request.kind !== stage.kind) {
        integrity("the request and stage kinds disagree");
      }
      return "clear";
    case "evm.typed-data":
      if (request.kind !== "evm.typed-data") {
        integrity("the request is not evm typed data");
      }
      return evmDisplay(info, { kind: "evm.typed-data", typedData: request.typedData });
    case "solana.transaction":
      if (request.kind !== "solana.transaction" || task === undefined) {
        integrity("the request is not a solana transaction");
      }
      return solanaDisplay(
        { kind: "solana.transaction", message: request.message },
        task.publicKey,
      );
    case "solana.message":
      if (request.kind !== "solana.message" || task === undefined) {
        integrity("the request is not a solana message");
      }
      return solanaDisplay({ kind: "solana.message", message: request.message }, task.publicKey);
    case "tron.transaction":
      if (request.kind !== "tron.transaction" || task === undefined) {
        integrity("the request is not a tron transaction");
      }
      return tronDisplay({ kind: "tron.transaction", rawData: request.rawData }, task.publicKey);
    case "tron.message":
      if (request.kind !== "tron.message" || task === undefined) {
        integrity("the request is not a tron message");
      }
      return tronDisplay({ kind: "tron.message" }, task.publicKey);
    case "tron.typed-data":
      // The wire has no TRON typed-data message — the family display refuses it outright.
      return "unsupported";
    case "bitcoin.psbt":
      if (request.kind !== "bitcoin.psbt") {
        integrity("the request is not a bitcoin psbt");
      }
      return bitcoinDisplay(info, {
        kind: "bitcoin.psbt",
        psbt: request.psbt,
        network: btcCoinName(request.network),
        sign: psbtEntries(request, stage),
        change: [],
      });
    case "bitcoin.message":
      if (request.kind !== "bitcoin.message") {
        integrity("the request is not a bitcoin message");
      }
      return bitcoinDisplay(info, { kind: "bitcoin.message", format: request.format });
  }
};

export const display: Driver["display"] = (request, plan, identity) => {
  const info = infoOf(identity);
  if (info === undefined) {
    return "unsupported";
  }
  return displayFor(request, plan, info);
};
