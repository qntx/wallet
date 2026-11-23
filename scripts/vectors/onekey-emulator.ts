/// <reference types="node" />
/**
 * Records a live OneKey Classic 1S emulator session into vectors/onekey/emulator-classic1s.json:
 * the raw request/response byte streams of (1) Initialize on a fresh device, (2) LoadDevice of the
 * public test mnemonic — the device asks a button confirm that the debug link answers — and (3)
 * Initialize again once the wallet is loaded. Replayed offline by tests/onekey-emulator.test.ts, so
 * this script deliberately uses the client's own framing and codec (the recording is the oracle,
 * not a second implementation).
 *
 * Run against a running emulator container:
 * docker run -d --name onekey-emu-classic1s-rec\
 * -p 127.0.0.1:54945-54946:54935-54936/udp onekey-emu-classic1s
 * bun scripts/vectors/onekey-emulator.ts --port 54945 --debug-port 54946
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { bytesToHex } from "@noble/hashes/utils.js";

import {
  decodeMessage,
  encodeMessage,
} from "../../packages/wallet-kernel/src/modules/onekey/protocol/frame.ts";
import {
  address,
  evmPublicNode,
  publicNode,
  solanaPublicKey,
} from "../../packages/wallet-kernel/src/modules/onekey/protocol/keys.ts";
import { Initialize } from "../../packages/wallet-kernel/src/modules/onekey/protocol/messages.ts";
import { encode } from "../../packages/wallet-kernel/src/modules/onekey/protocol/proto.ts";
import type { Exchange } from "../../packages/wallet-kernel/src/modules/onekey/protocol/session.ts";
import {
  LoadDevice,
  TEST_MNEMONIC,
  debugYes,
  udpExchange,
} from "../../packages/wallet-kernel/tests/onekey-emulator/index.ts";

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

const HOST = arg("host", "127.0.0.1");
const PORT = Number(arg("port", "54935"));
const DEBUG_PORT = Number(arg("debug-port", "54936"));
const DEVICE = arg("device", "classic1s");
const OUT = resolve(import.meta.dirname, `../../vectors/onekey/emulator-${DEVICE}.json`);

const exchange = udpExchange(HOST, PORT);

type Step = { request: string; response: string };
const sessions: Array<{ name: string; exchanges: Step[] }> = [];

async function step(session: { exchanges: Step[] }, data: Uint8Array): Promise<Uint8Array> {
  const response = await exchange(data);
  session.exchanges.push({ request: bytesToHex(data), response: bytesToHex(response) });
  return response;
}

const initializeRequest = (): Uint8Array =>
  encodeMessage(Initialize.typeId, encode(Initialize, {}));

const uninitialized = { name: "uninitialized", exchanges: [] as Step[] };
const first = decodeMessage(await step(uninitialized, initializeRequest()));
if (first.type !== 17) {
  throw new Error(`expected Features, got message type ${first.type}`);
}

const load = { name: "load-device", exchanges: [] as Step[] };
const buttonRequest = decodeMessage(
  await step(
    load,
    encodeMessage(
      LoadDevice.typeId,
      encode(LoadDevice, { mnemonics: [TEST_MNEMONIC], label: "OneKey" }),
    ),
  ),
);
if (buttonRequest.type !== 26) {
  throw new Error(`expected ButtonRequest, got message type ${buttonRequest.type}`);
}
// The device waits for the physical confirm; the debug link presses YES while the ButtonAck
// exchange is open on the main link.
const pending = exchange(encodeMessage(27, new Uint8Array()));
await debugYes(HOST, DEBUG_PORT);
const success = await pending;
load.exchanges.push({
  request: bytesToHex(encodeMessage(27, new Uint8Array())),
  response: bytesToHex(success),
});
if (decodeMessage(success).type !== 2) {
  throw new Error(`expected Success, got message type ${decodeMessage(success).type}`);
}

const initialized = { name: "initialized", exchanges: [] as Step[] };
const last = decodeMessage(await step(initialized, initializeRequest()));
if (last.type !== 17) {
  throw new Error(`expected Features, got message type ${last.type}`);
}

sessions.push(uninitialized, load, initialized);

// Layer 2: public nodes and addresses through the keys.ts API. Every exchange is recorded; a
// ButtonAck request (message type 27) means the device is about to show a confirmation dialog,
// so a DebugLink YES is pressed while that exchange waits for the follow-up response.
const H = 0x80_00_00_00;
const recording = (session: { exchanges: Step[] }): Exchange => {
  return async (data: Uint8Array): Promise<Uint8Array> => {
    let presser: ReturnType<typeof setInterval> | undefined;
    if (decodeMessage(data).type === 27) {
      // The confirmation dialog takes a moment to appear after the ack; keep pressing YES until
      // the device answers — presses on the idle screen are ignored.
      presser = setInterval(() => {
        void debugYes(HOST, DEBUG_PORT);
      }, 200);
    }
    try {
      const response = await exchange(data);
      session.exchanges.push({ request: bytesToHex(data), response: bytesToHex(response) });
      return response;
    } finally {
      if (presser !== undefined) {
        clearInterval(presser);
      }
    }
  };
};

for (const [name, path, scriptType] of [
  ["node-bip44", [H + 44, H, H], 0],
  ["node-bip49", [H + 49, H, H], 4],
  ["node-bip84", [H + 84, H, H], 3],
  ["node-bip86", [H + 86, H, H], 5],
  ["node-tron", [H + 44, H + 195, H], undefined],
] as const) {
  const session = { name, exchanges: [] as Step[] };
  // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
  const node = await publicNode(
    recording(session),
    path,
    scriptType === undefined ? undefined : { scriptType },
  );
  sessions.push(session);
  console.log(
    `${name}: pub=${bytesToHex(node.publicKey)} chain=${bytesToHex(node.chainCode)} ` +
      `parent=${bytesToHex(node.parent)} root=${node.rootFingerprint === undefined ? "none" : bytesToHex(node.rootFingerprint)}`,
  );
}
{
  const session = { name: "node-evm", exchanges: [] as Step[] };
  const node = await evmPublicNode(recording(session), [H + 44, H + 60, H]);
  sessions.push(session);
  console.log(
    `node-evm: pub=${bytesToHex(node.publicKey)} chain=${bytesToHex(node.chainCode)} ` +
      `parent=${bytesToHex(node.parent)}`,
  );
}
// showDisplay is false: on the Classic 1S emulator a shown address runs a multi-screen loop on
// protectWaitKey/keyScan (SDL arrow keys), which DebugLinkDecision cannot service — only the
// initial ButtonRequest round honours it — so a display call can never complete headlessly.
for (const [name, family, path, extra] of [
  ["addr-bip84", "bitcoin", [H + 84, H, H, 0, 0], { scriptType: 3 }],
  ["addr-evm", "evm", [H + 44, H + 60, H, 0, 0], { chainId: 1n }],
  ["addr-tron", "tron", [H + 44, H + 195, H, 0, 0], {}],
] as const) {
  const session = { name, exchanges: [] as Step[] };
  // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
  const value = await address(recording(session), family, path, { showDisplay: false, ...extra });
  sessions.push(session);
  console.log(`${name}: ${value}`);
}
for (const [name, path] of [
  ["sol-account0", [H + 44, H + 501, H, H]],
  ["sol-account1", [H + 44, H + 501, H + 1, H]],
] as const) {
  const session = { name, exchanges: [] as Step[] };
  // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
  const key = await solanaPublicKey(recording(session), path, false);
  sessions.push(session);
  console.log(`${name}: pub=${bytesToHex(key)}`);
}
const SOURCES = {
  classic1s: {
    repository: "https://github.com/OneKeyHQ/firmware-classic1s",
    commit: "be08c78d2230f11028bca55ae65469e64ad45e4a",
    tag: "v3.21.0",
    emulator:
      "onekey-emu-classic1s docker image (tests/onekey-emulator/Dockerfile.classic1s): EMULATOR=1 DEBUG_LINK=1 PRODUCTION=0 cibuild, SDL_VIDEODRIVER=dummy, UDP 54935 main / 54936 debug link; LoadDevice confirmed via DebugLinkDecision YES on the debug link",
    recorder: "bun scripts/vectors/onekey-emulator.ts",
  },
  pro: {
    repository: "https://github.com/OneKeyHQ/firmware-pro",
    commit: "251a1b762065357059f80f32b28cb502609510d3",
    tag: "v4.21.0",
    emulator:
      "onekey-emu-pro docker image (tests/onekey-emulator/Dockerfile.pro): PYOPT=0 make build_unix, SDL_VIDEODRIVER=dummy, TREZOR_UDP_IP=0.0.0.0, -X heapsize=32M, UDP 54935 main / 54936 debug link; LoadDevice confirmed via DebugLinkDecision YES on the debug link",
    recorder: "bun scripts/vectors/onekey-emulator.ts --device pro",
  },
} as const;
if (!(DEVICE in SOURCES)) {
  throw new Error(`unknown --device ${DEVICE}`);
}
const transcript = {
  source: SOURCES[DEVICE as keyof typeof SOURCES],
  sessions,
};
writeFileSync(OUT, `${JSON.stringify(transcript, null, 1)}\n`);
console.log(`wrote ${OUT}`);
exchange.close();
