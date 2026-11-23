/// <reference types="node" />
/* oxlint-disable typescript/no-unsafe-type-assertion -- the JSON signing-plan oracle is untyped */
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
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { bytesToHex } from "@noble/hashes/utils.js";

import type { EvmTransaction } from "../../packages/wallet-chains/src/index.ts";
import { initialize } from "../../packages/wallet-kernel/src/modules/onekey/protocol/device.ts";
import { OneKeyError } from "../../packages/wallet-kernel/src/modules/onekey/protocol/errors.ts";
import {
  signEvmPersonalMessage,
  signEvmTransaction,
  signTypedData,
} from "../../packages/wallet-kernel/src/modules/onekey/protocol/evm.ts";
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

// Layer 2: public nodes and addresses through the keys.ts API. Every exchange is recorded;
// while one is open the recorder keeps pressing YES on the debug link, which is what both a
// ButtonAck-gated protectButton and an ack-round-gated protectWaitKey consume.
const H = 0x80_00_00_00;
const recording = (session: { exchanges: Step[] }): Exchange => {
  return async (data: Uint8Array): Promise<Uint8Array> => {
    // Press YES on the debug link while every exchange is open: on the Classic 1S the signing
    // wizards wait in protectWaitKey inside whichever ack round precedes the screen — typed-data
    // value acks, tx acks — not only ButtonAck, and a stray press queues in msg_tiny until the
    // next key wait consumes it, which is exactly a user pressing early.
    const presser = setInterval(() => {
      void debugYes(HOST, DEBUG_PORT);
    }, 200);
    try {
      const response = await exchange(data);
      session.exchanges.push({ request: bytesToHex(data), response: bytesToHex(response) });
      return response;
    } finally {
      clearInterval(presser);
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
// Rule 2: a first-use address must be confirmable on the device itself. The same calls with
// showDisplay: true — each raises ButtonRequest rounds the DebugLink answers (type-26 responses
// in the transcript prove the device asked). Only on Pro: the Classic 1S emulator acknowledges
// the first ButtonRequest but then runs a multi-screen protectWaitKey/keyScan loop that needs
// SDL arrow-key events DebugLink cannot inject, so its shown-address exchanges never complete.
if (DEVICE === "pro") {
  for (const [name, family, path, extra] of [
    ["addr-bip84-show", "bitcoin", [H + 84, H, H, 0, 0], { scriptType: 3 }],
    ["addr-evm-show", "evm", [H + 44, H + 60, H, 0, 0], { chainId: 1n }],
    ["addr-tron-show", "tron", [H + 44, H + 195, H, 0, 0], {}],
  ] as const) {
    const session = { name, exchanges: [] as Step[] };
    // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
    const value = await address(recording(session), family, path, {
      showDisplay: true,
      ...extra,
    });
    sessions.push(session);
    console.log(`${name}: ${value}`);
  }
  {
    const session = { name: "sol-account0-show", exchanges: [] as Step[] };
    const key = await solanaPublicKey(recording(session), [H + 44, H + 501, H, H], true);
    sessions.push(session);
    console.log(`sol-account0-show: pub=${bytesToHex(key)}`);
  }
}
// Layer 3: EVM signing. Plan inputs come from vectors/chains/signing-plans.json so the
// replayed signatures verify against the plan digests; the big-data, contract-creation,
// unregistered-delegator and array/nested typed-data sessions are extras the tests verify
// independently. On the Classic 1S each signing wizard consumes one DebugLink YES per
// protectWaitKey screen, so the ButtonAck-open poll inside recording() walks the device
// through its multi-screen confirmation and back to the signature.
{
  const initSession = { name: "evm-init", exchanges: [] as Step[] };
  const info = await initialize(recording(initSession));
  sessions.push(initSession);
  console.log(`evm-init: ${info.model} ${info.firmware.join(".")}`);

  type PlanRequest = { tx?: EvmTransaction; message?: string; typedData?: string };
  const plans = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../vectors/chains/signing-plans.json"), "utf8"),
  ) as { cases: Array<{ name: string; key: { path: number[] }; request: PlanRequest }> };
  const planCase = (name: string) => {
    const found = plans.cases.find((c) => c.name === name);
    if (found === undefined) {
      throw new Error(`plan case ${name} missing from signing-plans.json`);
    }
    return found;
  };
  const evmPath = planCase("evm-legacy").key.path;
  const planTx = (name: string): EvmTransaction => {
    const { tx } = planCase(name).request;
    if (tx === undefined) {
      throw new Error(`plan case ${name} carries no transaction`);
    }
    return tx;
  };

  for (const name of ["evm-legacy", "evm-eip1559", "evm-eip1559-data"] as const) {
    const session = { name, exchanges: [] as Step[] };
    // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
    const result = await signEvmTransaction(recording(session), info, evmPath, planTx(name));
    sessions.push(session);
    console.log(`${name}: sig=${bytesToHex(result.signature).slice(0, 24)}…`);
  }

  // eip2930 has no OneKey message — `unsupported` before any exchange, so this session
  // records an empty exchange list on purpose.
  {
    const session = { name: "evm-eip2930", exchanges: [] as Step[] };
    try {
      await signEvmTransaction(recording(session), info, evmPath, planTx("evm-eip2930"));
      console.log("evm-eip2930: unexpectedly signed");
    } catch (error) {
      console.log(`evm-eip2930: ${error instanceof OneKeyError ? error.code : String(error)}`);
    }
    sessions.push(session);
  }

  // 2100 bytes of calldata: initial chunk 1024, then two TxRequest/TxAck rounds.
  {
    const session = { name: "evm-legacy-bigdata", exchanges: [] as Step[] };
    const result = await signEvmTransaction(recording(session), info, evmPath, {
      type: "legacy",
      chainId: 1,
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      value: "0x0",
      nonce: 10,
      gas: "0x40000",
      gasPrice: "0x3b9aca00",
      data: `0x${"ab".repeat(2100)}`,
    });
    sessions.push(session);
    console.log(
      `evm-legacy-bigdata: sig=${bytesToHex(result.signature).slice(0, 24)}… (${session.exchanges.length} exchanges)`,
    );
  }

  // Contract creation: `to` omitted, data is init code.
  {
    const session = { name: "evm-create", exchanges: [] as Step[] };
    const result = await signEvmTransaction(recording(session), info, evmPath, {
      type: "legacy",
      chainId: 1,
      value: "0x0",
      nonce: 11,
      gas: "0x100000",
      gasPrice: "0x3b9aca00",
      data: `0x${"6080604052".repeat(8)}`,
    });
    sessions.push(session);
    console.log(`evm-create: sig=${bytesToHex(result.signature).slice(0, 24)}…`);
  }

  // Two-stage EIP-7702: stage 1 returns the authorization signature, stage 2 passes it
  // back in `options.authorization` — the firmware skips re-signing and echoes it.
  for (const planName of ["evm-eip7702-upgrade", "evm-eip7702-revoke"] as const) {
    const stage1 = { name: `${planName}-stage1`, exchanges: [] as Step[] };
    // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
    const r1 = await signEvmTransaction(recording(stage1), info, evmPath, planTx(planName));
    sessions.push(stage1);
    const stage2 = { name: `${planName}-stage2`, exchanges: [] as Step[] };
    // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
    const r2 = await signEvmTransaction(
      recording(stage2),
      info,
      evmPath,
      planTx(planName),
      r1.authorization === undefined ? {} : { authorization: r1.authorization },
    );
    sessions.push(stage2);
    console.log(
      `${planName}: auth=${r1.authorization === undefined ? "none" : bytesToHex(r1.authorization.r).slice(0, 16)}… ` +
        `env=${bytesToHex(r2.signature).slice(0, 16)}…`,
    );
  }

  // An unregistered delegator: the device must refuse with Failure_DataError, mapped to
  // `unsupported` — the refusal exchange is part of the recording.
  {
    const session = { name: "evm-eip7702-unregistered", exchanges: [] as Step[] };
    const upgrade = planTx("evm-eip7702-upgrade");
    if (upgrade.type !== "eip7702") {
      throw new Error("evm-eip7702-upgrade is not an eip7702 transaction");
    }
    try {
      await signEvmTransaction(recording(session), info, evmPath, {
        ...upgrade,
        authorization: {
          address: "0x00000000000000000000000000000000dEaDbEEF",
        },
      });
      console.log("evm-eip7702-unregistered: unexpectedly signed");
    } catch (error) {
      console.log(
        `evm-eip7702-unregistered: ${error instanceof OneKeyError ? error.code : String(error)}`,
      );
    }
    sessions.push(session);
  }

  {
    const session = { name: "evm-personal-message", exchanges: [] as Step[] };
    const sig = await signEvmPersonalMessage(
      recording(session),
      evmPath,
      new Uint8Array(Buffer.from(planCase("evm-personal-message").request.message ?? "", "hex")),
    );
    sessions.push(session);
    console.log(`evm-personal-message: sig=${bytesToHex(sig).slice(0, 24)}…`);
  }

  // EIP-712: the plan's Mail document (stream mode), an array-of-structs + fixed-array
  // document (still stream), and a nested-array document (hash mode).
  const typedDocs: Array<[string, string]> = [
    ["evm-typed-data-mail", planCase("evm-typed-data-mail").request.typedData ?? ""],
    [
      "evm-typed-data-arrays",
      JSON.stringify({
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "chainId", type: "uint256" },
          ],
          Item: [
            { name: "id", type: "uint256" },
            { name: "owner", type: "address" },
          ],
          Batch: [
            { name: "items", type: "Item[]" },
            { name: "flags", type: "uint256[3]" },
            { name: "note", type: "string" },
          ],
        },
        primaryType: "Batch",
        domain: { name: "BatchTest", chainId: 1 },
        message: {
          items: [
            { id: "7", owner: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
            { id: "8", owner: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
          ],
          flags: ["1", "2", "3"],
          note: "two items",
        },
      }),
    ],
    [
      "evm-typed-data-nested",
      JSON.stringify({
        types: {
          EIP712Domain: [{ name: "name", type: "string" }],
          Grid: [{ name: "cells", type: "uint256[][]" }],
        },
        primaryType: "Grid",
        domain: { name: "GridTest" },
        message: { cells: [["1", "2"], ["3"]] },
      }),
    ],
  ];
  for (const [name, typedData] of typedDocs) {
    const session = { name, exchanges: [] as Step[] };
    // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
    const sig = await signTypedData(recording(session), info, evmPath, typedData);
    sessions.push(session);
    console.log(
      `${name}: sig=${bytesToHex(sig).slice(0, 24)}… (${session.exchanges.length} exchanges)`,
    );
  }
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
if (DEVICE !== "classic1s" && DEVICE !== "pro") {
  throw new Error(`unknown --device ${DEVICE}`);
}
const transcript = {
  source: SOURCES[DEVICE],
  sessions,
};
writeFileSync(OUT, `${JSON.stringify(transcript, null, 1)}\n`);
console.log(`wrote ${OUT}`);
exchange.close();
