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
import { Initialize } from "../../packages/wallet-kernel/src/modules/onekey/protocol/messages.ts";
import { encode } from "../../packages/wallet-kernel/src/modules/onekey/protocol/proto.ts";
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
const OUT = resolve(import.meta.dirname, "../../vectors/onekey/emulator-classic1s.json");

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
const transcript = {
  source: {
    repository: "https://github.com/OneKeyHQ/firmware-classic1s",
    commit: "be08c78d2230f11028bca55ae65469e64ad45e4a",
    tag: "v3.21.0",
    emulator:
      "onekey-emu-classic1s docker image (tests/onekey-emulator/Dockerfile.classic1s): EMULATOR=1 DEBUG_LINK=1 PRODUCTION=0 cibuild, SDL_VIDEODRIVER=dummy, UDP 54935 main / 54936 debug link; LoadDevice confirmed via DebugLinkDecision YES on the debug link",
    recorder: "bun scripts/vectors/onekey-emulator.ts",
  },
  sessions,
};
writeFileSync(OUT, `${JSON.stringify(transcript, null, 1)}\n`);
console.log(`wrote ${OUT}`);
exchange.close();
