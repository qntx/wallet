/**
 * card-surfaces-sim probe: a full kernel driven end to end against the real qntx card
 * applet — the C++ SimCardReader behind `__qntx.cardReader` talks to the card-sim bridge
 * over TCP. Runs `card.status` and one `card.create` (1-card, imported) round and posts the
 * outcome. The test CA1 anchor and a scripted secure input live here only; the production
 * kernel entry keeps `PRODUCTION_ANCHORS` and the native surfaces.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nobleBackend } from "@qntx/nostr";

import { bindNativeAnchor } from "../../../packages/wallet-native/kernel/anchor.ts";
import type { KernelAnchorNative } from "../../../packages/wallet-native/kernel/anchor.ts";
import { bindNativeCardReader } from "../../../packages/wallet-native/kernel/card.ts";
import { startKernel } from "../../../packages/wallet-kernel/src/kernel.ts";
import { shortId } from "../../../packages/wallet-kernel/src/modules/card/protocol/identity.ts";
import type { ProtocolValue } from "@qntx/wallet/protocol";
import type {
  KernelPlatform,
  SecureInput,
} from "../../../packages/wallet-kernel/src/platform.ts";
import { createMemoryStore } from "../../../packages/wallet-kernel/src/vault/memory.ts";

import { postJson, utf8Encode } from "./share.ts";

declare const __qntx: {
  readonly random: (length: number) => Uint8Array;
  readonly now: () => number;
  readonly elapsed: () => number;
  readonly setTimer: (delayMs: number, fn: () => void) => () => void;
  readonly cardReader: Parameters<typeof bindNativeCardReader>[0];
  readonly anchor: KernelAnchorNative;
  readonly pbkdf2: (
    hash: "sha256" | "sha512",
    password: Uint8Array,
    salt: Uint8Array,
    iterations: number,
    length: number,
    done: (result: Uint8Array | undefined, error: string | undefined) => void,
  ) => void;
  readonly argon2id: (
    password: Uint8Array,
    salt: Uint8Array,
    memoryKiB: number,
    passes: number,
    lanes: number,
    length: number,
    done: (result: Uint8Array | undefined, error: string | undefined) => void,
  ) => void;
};

/** Installed by the C++ probe host for card-surfaces-sim: the sim card's identity (33 B). */
declare const __qntxSimIdentity: () => ArrayBuffer;

// vectors/card/cert.json ca1.public — test-only anchor; production stays PRODUCTION_ANCHORS.
const CA1_ANCHOR = {
  batch: "ca1",
  key: hexToBytes(
    "04326ee50a70d17883e337bad61f8075e1510904110ca189423cb4fa3c7ae24d69bb49ba03e8e46321cadeee736ddc1fd1bcb0bc3dad5fdd598dd1a87c31b63f22",
  ),
};

const CODE = utf8Encode("harness card code");
const MNEMONIC = utf8Encode(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const PASSWORD = utf8Encode("harness vault password");

// Scripted trusted surface: access-code asks get the fixed code; the short-id ask answers
// the card's printed ID, derived from the identity the C++ reader saw in the bridge's
// `CARD <n> <cert>` line (the cert's first 33 bytes are the identity key).
const secureInput: SecureInput = {
  request: async (kind) => {
    await Promise.resolve();
    // Every ask gets a fresh buffer — the kernel owns and wipes what it is handed.
    const value =
      kind === "short-id" ? utf8Encode(shortId(new Uint8Array(__qntxSimIdentity()))) : CODE.slice();
    return { ok: true, value };
  },
  cancel: () => {},
};

const platform: KernelPlatform = {
  random: (length) => __qntx.random(length),
  now: () => __qntx.now(),
  elapsed: () => __qntx.elapsed(),
  setTimer: (delayMs, fn) => __qntx.setTimer(delayMs, fn),
  pbkdf2: async (hash, password, salt, iterations, length) =>
    new Promise((resolve, reject) => {
      __qntx.pbkdf2(hash, password, salt, iterations, length, (result, error) => {
        if (result === undefined) {
          reject(new Error(error ?? "pbkdf2 failed"));
          return;
        }
        resolve(result);
      });
    }),
  argon2id: async (password, salt, cost, length) =>
    new Promise((resolve, reject) => {
      __qntx.argon2id(
        password,
        salt,
        cost.memoryKiB,
        cost.passes,
        cost.lanes,
        length,
        (result, error) => {
          if (result === undefined) {
            reject(new Error(error ?? "argon2id failed"));
            return;
          }
          resolve(result);
        },
      );
    }),
  store: createMemoryStore(),
  anchor: bindNativeAnchor(__qntx.anchor),
  keystore: undefined,
  passkey: undefined,
  card: {
    reader: bindNativeCardReader(__qntx.cardReader),
    secureInput,
    anchors: [CA1_ANCHOR],
  },
  policy: { maxSessionMs: 24 * 3_600_000, maxScryptLogN: 18 },
  backends: {
    nostr: nobleBackend,
    // oxlint-disable-next-line typescript/require-await -- the loader signature is a promise
    spark: async () => {
      throw new Error("no spark backend in this probe");
    },
  },
};

type KernelResponse = { ok?: unknown; err?: { code?: string; message?: string } };

const pending = new Map<number, (message: unknown) => void>();
let nextId = 1;

const kernelPosts: unknown[] = [];

const port = {
  post: (message: ProtocolValue) => {
    const value = message as { id?: number };
    if (typeof value.id === "number" && pending.has(value.id)) {
      pending.get(value.id)?.(message);
      pending.delete(value.id);
      return;
    }
    kernelPosts.push(message);
  },
  listen: (handler: (message: unknown) => void) => {
    kernelHandler = handler;
    return () => {
      kernelHandler = undefined;
    };
  },
};

let kernelHandler: ((message: unknown) => void) | undefined;

const call = async (
  method: string,
  params: unknown,
  session?: string,
): Promise<Record<string, unknown>> => {
  const id = nextId;
  nextId += 1;
  const response = new Promise<KernelResponse>((resolve) => {
    pending.set(id, (message) => resolve(message as KernelResponse));
  });
  kernelHandler?.({ v: 3, id, method, session, params });
  const res = await response;
  if (res.err !== undefined) {
    throw new Error(`${method}: ${res.err.code ?? "?"} ${res.err.message ?? ""}`);
  }
  return res.ok as Record<string, unknown>;
};

startKernel(platform, port);

type Step = { kind: string; card?: string };

const drive = async (
  op: unknown,
  session: string,
  verify?: unknown,
): Promise<Record<string, unknown>> => {
  const first = (await call("card.begin", { op, ...(verify === undefined ? {} : { verify }) }, session)) as {
    opId: string;
    step: Step;
  };
  let step = first.step;
  const seen: Step[] = [{ kind: step.kind, ...(step.card === undefined ? {} : { card: step.card }) }];
  for (let guard = 0; step.kind !== "done"; guard += 1) {
    if (guard > 60) {
      throw new Error(`operation did not finish: ${JSON.stringify(step)}`);
    }
    try {
      step = (await call("card.step", { opId: first.opId }, session)) as Step;
    } catch (error) {
      throw new Error(`step after ${seen.map((s) => s.kind).join(">")}: ${describeError(error)}`);
    }
    seen.push({ kind: step.kind, ...(step.card === undefined ? {} : { card: step.card }) });
  }
  const result = (step as unknown as { result?: Record<string, unknown> }).result ?? {};
  return { ...result, steps: seen.map((s) => s.kind).join(">") };
};

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    const detail = (error as { code?: string }).code;
    return `${error.name}${detail === undefined ? "" : `:${detail}`} ${error.message}`;
  }
  return String(error);
};

const run = async (): Promise<void> => {
  postJson({ stage: "importing" });
  const imported = await call(
    "wallet.importMnemonic",
    // The kernel wipes the param bytes — factor and verify get separate copies.
    { mnemonic: MNEMONIC, factor: { kind: "password", password: PASSWORD.slice() } },
  );
  const session = imported["session"] as string;
  const walletId = (imported["wallet"] as { walletId: string }).walletId;

  postJson({ stage: "imported", session: session !== "" });
  const status = await drive({ kind: "status" }, session);
  postJson({ stage: "status-done" });
  const created = await drive(
    { kind: "create", cards: 1, source: { kind: "wallet", walletId } },
    session,
    { kind: "password", password: PASSWORD.slice() },
  );
  postJson({
    ok: true,
    card: bytesToHex(new Uint8Array(__qntxSimIdentity()).subarray(0, 4)),
    kernelPosts: kernelPosts.length,
    status,
    created,
  });
};

run().catch((error: unknown) => {
  postJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
});
