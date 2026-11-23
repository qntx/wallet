/**
 * A scripted Ledger on the device link. GET_APP_AND_VERSION (`B0 01`) is answered from the app's
 * pinned name/version so `requireApp` sees a real dashboard reply — pass `{ name, version }` to
 * pretend a different app is open. Every other APDU consumes one script step: a step carrying
 * `apdu` must match the sent bytes exactly (real transcripts replay byte-for-byte); a step without
 * one answers anything, which is how a test supplies derivations the vectors never recorded.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

import type { DeviceRequest, DeviceResponse } from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import { LEDGER_APPS } from "../src/modules/ledger/protocol/device.ts";
import type { LedgerApp } from "../src/modules/ledger/protocol/device.ts";
import type { DeviceLink } from "../src/modules/signers/driver.ts";

/** The speculos seed every recorded ledger vector derives from (vectors/ledger/*.json `seed`). */
export const MNEMONIC: string = (() => {
  const parsed: unknown = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../vectors/ledger/bitcoin.json", import.meta.url)),
      "utf8",
    ),
  );
  if (typeof parsed !== "object" || parsed === null || !("seed" in parsed)) {
    throw new Error("ledger bitcoin vectors carry no seed");
  }
  const { seed } = parsed;
  if (typeof seed !== "string") {
    throw new TypeError("ledger bitcoin vector seed is not a string");
  }
  return seed;
})();

export const SEED: Uint8Array = mnemonicToSeedSync(MNEMONIC);

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const unhex = (value: string): Uint8Array => {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(value.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
};

export const utf8Hex = (text: string): string => hex(utf8ToBytes(text));

/** A script step's response is `data ‖ SW` — `ok` appends the success status. */
export const ok = (dataHex: string): string => `${dataHex}9000`;

/** A step's `apdu` omitted means "any request" — the response still lands verbatim. */
export type ScriptStep = { readonly apdu?: string; readonly response: string };

type VectorFile = {
  cases: ReadonlyArray<{
    name: string;
    call: Record<string, unknown>;
    commands: ReadonlyArray<{ apdu: string; response: string }>;
    result?: unknown;
    error?: { code: string; sw?: number };
  }>;
};

export const vectors = (app: string): VectorFile => {
  const parsed: unknown = JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../vectors/ledger/${app}.json`, import.meta.url)),
      "utf8",
    ),
  );
  if (typeof parsed !== "object" || parsed === null || !("cases" in parsed)) {
    throw new Error(`ledger ${app} vectors carry no cases`);
  }
  const { cases } = parsed;
  if (!Array.isArray(cases)) {
    throw new TypeError(`ledger ${app} vector cases are not a list`);
  }
  return { cases };
};

export const vectorCase = (app: string, name: string): VectorFile["cases"][number] => {
  const found = vectors(app).cases.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(`no ${app} case ${name}`);
  }
  return found;
};

export const caseSteps = (app: string, name: string): ScriptStep[] => [
  ...vectorCase(app, name).commands,
];

const lv = (text: string): string => {
  const data = utf8Hex(text);
  return `${(data.length / 2).toString(16).padStart(2, "0")}${data}`;
};

const appAndVersionData = (name: string, version: string): string =>
  `01${lv(name)}${lv(version)}00`;

export type FakeLedger = {
  readonly link: DeviceLink;
  /** The APDUs the driver sent, in order — for tests asserting on wire traffic. */
  readonly sent: string[];
  /** Fails when the driver left script steps unexercised. */
  readonly done: () => void;
};

export const scriptedLedger = (
  app: LedgerApp | { readonly name: string; readonly version: string },
  steps: ReadonlyArray<ScriptStep>,
): FakeLedger => {
  const { name, version } =
    typeof app === "string"
      ? { name: LEDGER_APPS[app].name, version: LEDGER_APPS[app].minimum.join(".") }
      : app;
  const queue = [...steps];
  const sent: string[] = [];
  const link: DeviceLink = {
    // oxlint-disable-next-line typescript/require-await -- the link contract is async; the fake answers synchronously
    exchange: async (request: DeviceRequest): Promise<DeviceResponse> => {
      if (request.kind !== "message") {
        throw new KernelError("integrity", "ledger links carry only message requests");
      }
      const apdu = hex(request.data);
      sent.push(apdu);
      if (apdu === "b001000000") {
        return {
          kind: "message",
          data: unhex(ok(appAndVersionData(name, version))),
        };
      }
      const step = queue.shift();
      if (step === undefined) {
        throw new Error(`unscripted APDU ${apdu}`);
      }
      if (step.apdu !== undefined && step.apdu !== apdu) {
        throw new Error(`APDU drift — driver sent ${apdu}, expected ${step.apdu}`);
      }
      return { kind: "message", data: unhex(step.response) };
    },
  };
  return {
    link,
    sent,
    done: () => {
      if (queue.length > 0) {
        throw new Error(`${queue.length} scripted steps unexercised`);
      }
    },
  };
};

const pathText = (path: ReadonlyArray<number>): string =>
  `m/${path.map((n) => (n >= 0x80_00_00_00 ? `${n - 0x80_00_00_00}'` : `${n}`)).join("/")}`;

/** The mainnet xpub the device would report for `path` under the speculos seed. */
export const xpubAt = (path: ReadonlyArray<number>): string => {
  const key = HDKey.fromMasterSeed(SEED).derive(pathText(path));
  return key.publicExtendedKey;
};

/** The compressed secp256k1 key at `path` under the speculos seed. */
export const publicKeyAt = (path: ReadonlyArray<number>): Uint8Array => {
  const { publicKey } = HDKey.fromMasterSeed(SEED).derive(pathText(path));
  if (publicKey === null) {
    throw new Error("no public key");
  }
  return publicKey;
};
