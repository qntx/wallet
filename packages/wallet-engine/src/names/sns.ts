import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  isOffCurveAddress,
} from "@solana/kit";

import type { Independent, NetworkController, SolanaRpc } from "../networks/controller.ts";
import type { RequestCheckCode } from "../requests/checks.ts";
import { NameDisagreementError } from "./types.ts";
import type { NameResolution } from "./types.ts";

export const SNS_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SNS_NAME_PROGRAM = "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX";
export const SNS_ROOT_DOMAIN = "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx";
export const SNS_REVERSE_CLASS = "33m47vH6Eav6jr5Ry86XjhRft2jRBLDnDgPSHoquXi2Z";
export const SNS_RECORDS_PROGRAM = "HP3D4D1ZCmohQGFVms2SS4LCANgJyksBf5s1F77FuFjZ";
export const SNS_PRIMARY_PROGRAM = "85iDfUvr3HJyLM2zcq5BXSiDvUWfw6cSE1FfNBo8Ap29";

const HASH_PREFIX = new TextEncoder().encode("SPL Name Service");
const ZERO32 = new Uint8Array(32);
const HEADER_LENGTH = 96;
const addressEncoder = getAddressEncoder();

type Networks = Pick<NetworkController, "info" | "solanaRpc" | "independentSolanaRpc">;
type AccountBytes = { readonly owner: string; readonly data: Uint8Array };

const bytes = (value: string): Uint8Array => new Uint8Array(addressEncoder.encode(address(value)));

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const hashName = (name: string): Uint8Array =>
  sha256(new Uint8Array([...HASH_PREFIX, ...new TextEncoder().encode(name)]));

const programAddress = async (
  program: string,
  seeds: ReadonlyArray<Uint8Array>,
): Promise<string> => {
  const derived = await getProgramDerivedAddress({
    programAddress: address(program),
    seeds: [...seeds],
  });
  return derived[0];
};

const snsNameKey = async (
  hashed: Uint8Array,
  classKey?: Uint8Array,
  parentKey?: Uint8Array,
): Promise<string> =>
  programAddress(SNS_NAME_PROGRAM, [hashed, classKey ?? ZERO32, parentKey ?? ZERO32]);

/** The name-account key for `label` hashed verbatim under `parent` (the `.sns` root by default). */
export const snsDomainKey = async (label: string, parent = SNS_ROOT_DOMAIN): Promise<string> =>
  snsNameKey(hashName(label), undefined, bytes(parent));

/** The reverse-lookup account of a name account, under `parent` for a subdomain. */
export const snsReverseKey = async (nameAccount: string, parent?: string): Promise<string> =>
  snsNameKey(
    hashName(nameAccount),
    bytes(SNS_REVERSE_CLASS),
    parent === undefined ? undefined : bytes(parent),
  );

/** The legacy SOL record account whose content sits after the 96-byte registry header. */
export const snsSolRecordV1Key = async (domainKey: string): Promise<string> =>
  snsNameKey(hashName("\u0001SOL"), undefined, bytes(domainKey));

/** The records-program central state: the PDA of the program's own address under itself. */
export const snsRecordsCentralState = async (): Promise<string> =>
  programAddress(SNS_RECORDS_PROGRAM, [bytes(SNS_RECORDS_PROGRAM)]);

/** The v2 SOL record account under the domain key and the records central state. */
export const snsSolRecordV2Key = async (domainKey: string): Promise<string> =>
  snsNameKey(hashName("\u0002SOL"), bytes(await snsRecordsCentralState()), bytes(domainKey));

/** The primary-domain account SNS's offers program derives for an owner. */
export const snsPrimaryDomainKey = async (owner: string): Promise<string> =>
  programAddress(SNS_PRIMARY_PROGRAM, [new TextEncoder().encode("favourite_domain"), bytes(owner)]);

type ParsedSnsName = {
  readonly normalized: string;
  readonly labels: ReadonlyArray<string>;
};

const validLabels = (labels: ReadonlyArray<string>): boolean =>
  (labels.length === 1 || labels.length === 2) &&
  labels.every((label) => /^[a-z0-9_-]{1,63}$/.test(label));

const parseSnsName = (input: string): ParsedSnsName => {
  const lowered = input.toLowerCase();
  if (lowered.endsWith(".sol")) {
    throw new Error(
      'SNS paused ".sol" resolution during its SRS migration; use the ".sns" name instead',
    );
  }
  if (!lowered.endsWith(".sns")) {
    throw new Error(`"${input}" is not an SNS name ending in .sns`);
  }
  const labels = lowered.slice(0, -".sns".length).split(".");
  if (!validLabels(labels)) {
    throw new Error(`"${input}" is not a valid SNS name`);
  }
  return { normalized: `${labels.join(".")}.sns`, labels };
};

const deriveDomain = async (
  labels: ReadonlyArray<string>,
): Promise<{ readonly key: string; readonly parent: string }> => {
  const [first, second] = labels;
  if (first === undefined) {
    throw new Error("SNS name is empty");
  }
  if (second === undefined) {
    return { key: await snsDomainKey(first), parent: SNS_ROOT_DOMAIN };
  }
  const parent = await snsDomainKey(second);
  return { key: await snsDomainKey(`\0${first}`, parent), parent };
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const parseAccounts = (raw: unknown, count: number): Array<AccountBytes | undefined> => {
  const value = isObject(raw) ? raw["value"] : undefined;
  if (!Array.isArray(value) || value.length !== count) {
    throw new Error("malformed getMultipleAccounts response");
  }
  return value.map((slot): AccountBytes | undefined => {
    if (slot === null) {
      return undefined;
    }
    if (!isObject(slot) || typeof slot["owner"] !== "string") {
      throw new Error("malformed getMultipleAccounts response");
    }
    const field: unknown = slot["data"];
    if (!Array.isArray(field)) {
      throw new TypeError("malformed getMultipleAccounts response");
    }
    const data: unknown = field[0];
    if (typeof data !== "string") {
      throw new TypeError("malformed getMultipleAccounts response");
    }
    return { owner: slot["owner"], data: base64.decode(data) };
  });
};

const sameAccount = (a: AccountBytes | undefined, b: AccountBytes | undefined): boolean =>
  (a === undefined && b === undefined) ||
  (a !== undefined && b !== undefined && a.owner === b.owner && sameBytes(a.data, b.data));

/**
 * Accounts answered identically by both endpoints — bytes and owner compared slot-for-slot; a
 * failed independent read degrades to `reads-unverified`.
 */
const crossCheckedAccounts = async (
  rpc: SolanaRpc,
  independent: Independent<SolanaRpc>,
  keys: ReadonlyArray<string>,
  flags: RequestCheckCode[],
): Promise<Array<AccountBytes | undefined>> => {
  const config = { encoding: "base64", commitment: "confirmed" };
  const primary = parseAccounts(
    await rpc.call("getMultipleAccounts", [[...keys], config]),
    keys.length,
  );
  if (independent.kind === "available") {
    let other: Array<AccountBytes | undefined> | undefined;
    try {
      other = parseAccounts(
        await independent.client.call("getMultipleAccounts", [[...keys], config]),
        keys.length,
      );
    } catch {
      if (!flags.includes("reads-unverified")) {
        flags.push("reads-unverified");
      }
    }
    if (other !== undefined && !primary.every((slot, index) => sameAccount(slot, other[index]))) {
      throw new NameDisagreementError("the endpoints disagree on the SNS accounts");
    }
  } else if (independent.kind === "unavailable" && !flags.includes("reads-unverified")) {
    flags.push("reads-unverified");
  }
  return primary;
};

const u16le = (data: Uint8Array, at: number): number =>
  new DataView(data.buffer, data.byteOffset + at, 2).getUint16(0, true);

const u32le = (data: Uint8Array, at: number): number =>
  new DataView(data.buffer, data.byteOffset + at, 4).getUint32(0, true);

const validationLength = (validation: number): number | undefined => {
  if (validation === 0) {
    return 0;
  }
  if (validation === 1 || validation === 3) {
    return 32;
  }
  if (validation === 2) {
    return 20;
  }
  return undefined;
};

const refuse = (name: string, reason: string): Error =>
  new Error(`SNS name "${name}" is refused: ${reason}`);

const checkRecordV1 = (name: string, record: AccountBytes, owner: Uint8Array): void => {
  if (record.data.length < HEADER_LENGTH + 32) {
    throw refuse(name, "malformed SOL record v1");
  }
  if (!sameBytes(record.data.slice(HEADER_LENGTH, HEADER_LENGTH + 32), owner)) {
    throw refuse(name, "SOL record v1 points away from the name owner");
  }
};

const checkRecordV2 = (name: string, record: AccountBytes, owner: Uint8Array): void => {
  if (record.data.length < HEADER_LENGTH + 8) {
    throw refuse(name, "malformed SOL record v2");
  }
  const stalenessValidation = u16le(record.data, HEADER_LENGTH);
  const roaValidation = u16le(record.data, HEADER_LENGTH + 2);
  const contentLength = u32le(record.data, HEADER_LENGTH + 4);
  const stalenessLength = validationLength(stalenessValidation);
  const roaLength = validationLength(roaValidation);
  if (stalenessLength === undefined || roaLength === undefined || contentLength !== 32) {
    throw refuse(name, "malformed SOL record v2");
  }
  const contentAt = HEADER_LENGTH + 8 + stalenessLength + roaLength;
  if (record.data.length < contentAt + contentLength) {
    throw refuse(name, "malformed SOL record v2");
  }
  if (!sameBytes(record.data.slice(contentAt, contentAt + contentLength), owner)) {
    throw refuse(name, "SOL record v2 points away from the name owner");
  }
};

const requireMainnet = (network: string): void => {
  if (network !== SNS_MAINNET) {
    throw new Error("SNS names resolve only on Solana mainnet");
  }
};

/** Forward-resolves an `.sns` name on Solana mainnet; throws when it cannot be resolved safely. */
export const resolveSns = async (
  networks: Networks,
  input: string,
  network: string,
): Promise<NameResolution> => {
  requireMainnet(network);
  const info = networks.info(network);
  if (info.family !== "solana") {
    throw new Error("SNS names can only resolve for Solana networks");
  }
  const parsed = parseSnsName(input);
  const derived = await deriveDomain(parsed.labels);
  const keys = [
    derived.key,
    await snsSolRecordV1Key(derived.key),
    await snsSolRecordV2Key(derived.key),
  ];
  const checks: RequestCheckCode[] = [];
  const [nameAccount, recordV1, recordV2] = await crossCheckedAccounts(
    networks.solanaRpc(network),
    networks.independentSolanaRpc(network),
    keys,
    checks,
  );
  if (nameAccount === undefined) {
    throw new Error(`SNS name "${parsed.normalized}" does not resolve`);
  }
  if (nameAccount.owner !== SNS_NAME_PROGRAM) {
    throw refuse(parsed.normalized, "the name account is not owned by the name program");
  }
  if (nameAccount.data.length < HEADER_LENGTH) {
    throw refuse(parsed.normalized, "malformed name account");
  }
  if (!sameBytes(nameAccount.data.slice(0, 32), bytes(derived.parent))) {
    throw refuse(parsed.normalized, "the name account parent does not match its derivation");
  }
  const owner = nameAccount.data.slice(32, 64);
  if (owner.every((byte) => byte === 0)) {
    throw refuse(parsed.normalized, "the name owner is the zero address");
  }
  const ownerBase58 = base58.encode(owner);
  if (isOffCurveAddress(address(ownerBase58))) {
    throw refuse(parsed.normalized, "the name owner is a program-derived address");
  }
  if (recordV1 !== undefined) {
    checkRecordV1(parsed.normalized, recordV1, owner);
  }
  if (recordV2 !== undefined) {
    checkRecordV2(parsed.normalized, recordV2, owner);
  }
  return {
    name: parsed.normalized,
    address: ownerBase58,
    checks,
    risk: [],
  };
};

const decodeOwner = (value: string): Uint8Array => {
  const decoded = base58.decode(value);
  if (decoded.length !== 32) {
    throw new Error(`invalid Solana address ${value}`);
  }
  return decoded;
};

const parseReversePayload = (data: Uint8Array): string | undefined => {
  if (data.length < HEADER_LENGTH + 4) {
    return undefined;
  }
  const length = u32le(data, HEADER_LENGTH);
  const start = HEADER_LENGTH + 4;
  if (length > data.length - start) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data.slice(start, start + length));
  } catch {
    return undefined;
  }
};

const registryAccount = (account: AccountBytes | undefined): AccountBytes | undefined =>
  account !== undefined &&
  account.owner === SNS_NAME_PROGRAM &&
  account.data.length >= HEADER_LENGTH
    ? account
    : undefined;

/**
 * The verified primary `.sns` name for `address`, or `undefined` when the primary or reverse data
 * is absent, malformed, or no longer forward-resolves to the same address.
 */
export const lookupSns = async (
  networks: Networks,
  owner: string,
  network: string,
): Promise<NameResolution | undefined> => {
  requireMainnet(network);
  const info = networks.info(network);
  if (info.family !== "solana") {
    throw new Error("SNS names can only resolve for Solana networks");
  }
  decodeOwner(owner);
  const checks: RequestCheckCode[] = [];
  const rpc = networks.solanaRpc(network);
  const independent = networks.independentSolanaRpc(network);
  const [primary] = await crossCheckedAccounts(
    rpc,
    independent,
    [await snsPrimaryDomainKey(owner)],
    checks,
  );
  if (primary === undefined || primary.data.length < 33) {
    return undefined;
  }
  const nameAccountKey = base58.encode(primary.data.slice(1, 33));
  const [nameAccount] = await crossCheckedAccounts(rpc, independent, [nameAccountKey], checks);
  const registry = registryAccount(nameAccount);
  if (registry === undefined) {
    return undefined;
  }
  const parentBytes = registry.data.slice(0, 32);
  let candidate: string | undefined;
  if (sameBytes(parentBytes, bytes(SNS_ROOT_DOMAIN))) {
    const reverseKey = await snsReverseKey(nameAccountKey);
    const [reverse] = await crossCheckedAccounts(rpc, independent, [reverseKey], checks);
    const reverseAccount = registryAccount(reverse);
    candidate = reverseAccount === undefined ? undefined : parseReversePayload(reverseAccount.data);
  } else {
    const parentKey = base58.encode(parentBytes);
    const reverseKey = await snsReverseKey(nameAccountKey, parentKey);
    const parentReverseKey = await snsReverseKey(parentKey);
    const [reverse, parentReverse] = await crossCheckedAccounts(
      rpc,
      independent,
      [reverseKey, parentReverseKey],
      checks,
    );
    const reverseAccount = registryAccount(reverse);
    const parentReverseAccount = registryAccount(parentReverse);
    const sub = reverseAccount === undefined ? undefined : parseReversePayload(reverseAccount.data);
    const parent =
      parentReverseAccount === undefined
        ? undefined
        : parseReversePayload(parentReverseAccount.data);
    candidate =
      sub !== undefined && parent !== undefined && sub.startsWith("\0")
        ? `${sub.slice(1)}.${parent}`
        : undefined;
  }
  if (candidate === undefined || !validLabels(candidate.split("."))) {
    return undefined;
  }
  const normalized = `${candidate}.sns`;
  let forward: NameResolution;
  try {
    forward = await resolveSns(networks, normalized, network);
  } catch (error) {
    if (error instanceof NameDisagreementError) {
      throw error;
    }
    return undefined;
  }
  if (forward.address !== owner) {
    return undefined;
  }
  const merged = [...checks];
  for (const check of forward.checks) {
    if (!merged.includes(check)) {
      merged.push(check);
    }
  }
  return { name: normalized, address: owner, checks: merged, risk: [] };
};
