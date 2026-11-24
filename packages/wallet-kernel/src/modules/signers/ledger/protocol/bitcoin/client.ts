/**
 * The interactive protocol behind REGISTER_WALLET/GET_WALLET_ADDRESS/SIGN_PSBT/SIGN_MESSAGE
 * (doc/bitcoin.md "Interactive commands" and "Client commands reference"). The state machine is the
 * reference ClientCommandInterpreter and its per-command handlers in
 * bitcoin_client_js/src/lib/clientCommands.ts, driven like appClient.ts makeRequest: SW 0x9000
 * returns the final response, SW 0xE000 carries one client command answered with `F8 01 00 01`
 * (CONTINUE, P2 = protocol version 1), and any other word goes through the status allow-list.
 * Unlike the reference, a misbehaving device is bounded: more than `maxRounds` interruptions is
 * `invalid-response`.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { Command, Exchange } from "../apdu.ts";
import { decodeResponse, encodeCommand } from "../apdu.ts";
import { input, Reader, varint } from "../bytes.ts";
import { LedgerError } from "../errors.ts";
import { statusError } from "../status.ts";
import { leafHash, merkleProof, merkleRoot } from "./merkle.ts";
import type { BitcoinPolicy } from "./policy.ts";
import { ascii, serializePolicy } from "./policy.ts";
import type { KeyValue } from "./psbt.ts";

/**
 * Everything the device may ask about during one call: preimages by sha256 hex, and Merkle trees by
 * root hex (as their leaf hashes, which is all the leaf-proof/index commands need).
 */
export type Known = {
  readonly preimages: Map<string, Uint8Array>;
  readonly trees: Map<string, ReadonlyArray<Uint8Array>>;
};

export const newKnown = (): Known => ({ preimages: new Map(), trees: new Map() });

/** AddKnownPreimage — a plain sha256 lookup for blobs like the serialized policy/template. */
export const knownPreimage = (known: Known, preimage: Uint8Array): void => {
  known.preimages.set(bytesToHex(sha256(preimage)), preimage);
};

/**
 * AddKnownList — every element is served both as the leaf-hash preimage `0x00 ‖ element` (the
 * device asks for sha256(0x00‖el) and strips the leaf domain byte) and through its tree root.
 */
export const knownList = (known: Known, elements: ReadonlyArray<Uint8Array>): void => {
  const leaves = elements.map((el) => leafHash(el));
  for (const el of elements) {
    const preimage = new Uint8Array(1 + el.length);
    preimage.set(el, 1);
    knownPreimage(known, preimage);
  }
  known.trees.set(bytesToHex(merkleRoot(leaves)), leaves);
};

/** AddKnownMapping — a merkleized map registers its key list and its value list. */
export const knownMapping = (known: Known, kvs: ReadonlyArray<KeyValue>): void => {
  knownList(
    known,
    kvs.map((kv) => kv.key),
  );
  knownList(
    known,
    kvs.map((kv) => kv.value),
  );
};

/** AddKnownWalletPolicy — policy serialization, descriptor template, and the key-info list. */
export const knownWalletPolicy = (known: Known, policy: BitcoinPolicy): void => {
  knownPreimage(known, serializePolicy(policy));
  knownPreimage(known, ascii(policy.template));
  knownList(known, [ascii(policy.key)]);
};

/**
 * The round bound for `interact`. A compliant device asks a leaf-index or leaf-proof command plus a
 * preimage command per element and re-walks a tree per leaf it visits, so usage grows quadratically
 * in tree size: the recorded Speculos transcripts use ≤ 1.4 rounds per (preimage + Σn² over trees).
 * `8 + 6 × (preimages + Σn²) + Σceil(len/253)` leaves the largest recorded case under a quarter of
 * its bound while still cutting off a device that loops.
 */
export const maxRounds = (known: Known): number => {
  let cost = 0;
  for (const preimage of known.preimages.values()) {
    cost += Math.ceil(preimage.length / 253);
  }
  for (const tree of known.trees.values()) {
    cost += tree.length * tree.length;
  }
  return 8 + 6 * (known.preimages.size + cost);
};

const invalid = (message: string): LedgerError => new LedgerError("invalid-response", message);

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

type State = {
  readonly known: Known;
  /** Elements spilled by an oversized answer, served to GET_MORE_ELEMENTS first-in-first-out. */
  readonly queue: Uint8Array[];
  readonly yielded: Uint8Array[];
};

// CCMD_YIELD — the payload is opaque here; the SIGN_PSBT caller parses it strictly.
const yieldCommand = (state: State, request: Uint8Array): Uint8Array => {
  if (request.length === 0) {
    throw invalid("YIELD carries no data");
  }
  state.yielded.push(Uint8Array.from(request));
  return new Uint8Array(0);
};

// CCMD_GET_PREIMAGE — `00 ‖ hash32` → `varint len ‖ u8 b ‖ first b bytes`, b maximal so the reply
// stays ≤ 255 bytes; the rest is queued as single-byte elements (clientCommands.ts).
const preimageCommand = (state: State, request: Uint8Array): Uint8Array => {
  const reader = new Reader(request);
  if (reader.u8() !== 0x00) {
    throw invalid("GET_PREIMAGE request version is not 0");
  }
  const hash = reader.bytes(32);
  reader.end();
  const preimage = state.known.preimages.get(bytesToHex(hash));
  if (preimage === undefined) {
    throw invalid("GET_PREIMAGE asked for an unknown hash");
  }
  const count = varint(preimage.length);
  const payload = Math.min(255 - count.length - 1, preimage.length);
  for (let i = payload; i < preimage.length; i += 1) {
    state.queue.push(preimage.subarray(i, i + 1));
  }
  return concat(count, Uint8Array.of(payload), preimage.subarray(0, payload));
};

// CCMD_GET_MERKLE_LEAF_PROOF — `root32 ‖ varint size ‖ varint index` → `leafhash ‖ u8 proofLen ‖
// u8 p ‖ first p hashes`, the proof tail queued as 32-byte elements (clientCommands.ts).
const leafProofCommand = (state: State, request: Uint8Array): Uint8Array => {
  const reader = new Reader(request);
  const root = bytesToHex(reader.bytes(32));
  const size = reader.varint();
  const index = reader.varint();
  reader.end();
  const tree = state.known.trees.get(root);
  if (tree === undefined) {
    throw invalid("GET_MERKLE_LEAF_PROOF asked for an unknown root");
  }
  if (size !== tree.length || index >= size) {
    throw invalid("GET_MERKLE_LEAF_PROOF size or index is out of range");
  }
  if (state.queue.length > 0) {
    throw invalid("GET_MERKLE_LEAF_PROOF arrived with a pending queue");
  }
  const proof = merkleProof(tree, index);
  const answer = Math.min(Math.floor((255 - 32 - 1 - 1) / 32), proof.length);
  for (const hash of proof.slice(answer)) {
    state.queue.push(hash);
  }
  return concat(
    ...tree.slice(index, index + 1),
    Uint8Array.of(proof.length),
    Uint8Array.of(answer),
    ...proof.slice(0, answer),
  );
};

// CCMD_GET_MERKLE_LEAF_INDEX — `root32 ‖ leafhash32` → `u8 found ‖ varint index` (index 0 when
// not found, clientCommands.ts GetMerkleLeafIndexCommand).
const leafIndexCommand = (state: State, request: Uint8Array): Uint8Array => {
  const reader = new Reader(request);
  const root = bytesToHex(reader.bytes(32));
  const leaf = reader.bytes(32);
  reader.end();
  const tree = state.known.trees.get(root);
  if (tree === undefined) {
    throw invalid("GET_MERKLE_LEAF_INDEX asked for an unknown root");
  }
  if (state.queue.length > 0) {
    throw invalid("GET_MERKLE_LEAF_INDEX arrived with a pending queue");
  }
  const index = tree.findIndex((hash) => equalBytes(hash, leaf));
  return concat(Uint8Array.of(index === -1 ? 0 : 1), varint(Math.max(index, 0)));
};

// CCMD_GET_MORE_ELEMENTS — empty request → `u8 n ‖ u8 size ‖ n×size`, as many same-length queued
// elements as fit in 255 bytes (clientCommands.ts GetMoreElementsCommand).
const moreElementsCommand = (state: State, request: Uint8Array): Uint8Array => {
  if (request.length > 0) {
    throw invalid("GET_MORE_ELEMENTS carries trailing bytes");
  }
  const [first] = state.queue;
  if (first === undefined) {
    throw invalid("GET_MORE_ELEMENTS has an empty queue");
  }
  const count = Math.min(Math.floor(253 / first.length), state.queue.length);
  const returned = state.queue.splice(0, count);
  return concat(Uint8Array.of(count), Uint8Array.of(first.length), ...returned);
};

const dispatch = (state: State, request: Uint8Array): Uint8Array => {
  const [code] = request;
  const rest = request.subarray(1);
  switch (code) {
    case 0x10:
      return yieldCommand(state, rest);
    case 0x40:
      return preimageCommand(state, rest);
    case 0x41:
      return leafProofCommand(state, rest);
    case 0x42:
      return leafIndexCommand(state, rest);
    case 0xa0:
      return moreElementsCommand(state, rest);
    default:
      throw invalid("unknown client command code");
  }
};

/**
 * Run `command` (an `E1` APDU) and serve every client command the device asks, up to `maxRounds`
 * interruptions. Returns the final response data and everything the device yielded.
 */
export async function interact(
  exchange: Exchange,
  command: Command,
  known: Known,
  rounds: number,
): Promise<{ readonly data: Uint8Array; readonly yielded: ReadonlyArray<Uint8Array> }> {
  if (!Number.isSafeInteger(rounds) || rounds < 0) {
    throw input("maxRounds is not a non-negative integer");
  }
  const state: State = { known, queue: [], yielded: [] };
  let { data, sw } = decodeResponse(await exchange(encodeCommand(command)));
  for (let round = 0; ; round += 1) {
    if (sw === 0x90_00) {
      return { data, yielded: state.yielded };
    }
    if (sw !== 0xe0_00) {
      throw statusError("bitcoin", sw);
    }
    if (round >= rounds) {
      throw invalid("the device exceeded its client-command budget");
    }
    const answer = dispatch(state, data);
    // oxlint-disable-next-line eslint/no-await-in-loop -- rounds are sequential on one link
    const response = await exchange(
      encodeCommand({ cla: 0xf8, ins: 0x01, p1: 0x00, p2: 0x01, data: answer }),
    );
    ({ data, sw } = decodeResponse(response));
  }
}
