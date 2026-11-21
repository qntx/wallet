/**
 * The twelve contract value messages the wallet models, as both decode output and builder input — a
 * `TronContract` produced by a builder encodes byte-for-byte to what `decodeTronContract` reads
 * back. Schemas:
 * https://github.com/tronprotocol/protocol/blob/8432beca98c52ba04c82aea0b48ae9f9f882c82a
 * `core/contract/balance_contract.proto`, `asset_issue_contract.proto`, `smart_contract.proto`,
 * `witness_contract.proto`, `account_contract.proto` and `core/Tron.proto` (Permission).
 *
 * Wire rules on top of the strict reader: an address is exactly 21 bytes starting 0x41; a signed
 * int64 encoded ≥ 2^63 is a negative value and malformed, an int32 likewise past 2^31; a bool must
 * be 1 when present; enum fields stay raw numbers — an out-of-range enum is a classification
 * concern (`decodeTron`), not malformed bytes.
 */
import { tronAddressFromBytes, tronAddressToBytes, TRON_ADDRESS_PREFIX } from "./address.ts";
import {
  bytesField,
  collectExtra,
  encodeMessage,
  equalBytes,
  malformed,
  readFields,
  requiredBytesField,
  requiredVarintField,
  stringField,
  varintField,
} from "./proto.ts";
import type { ProtoExtra, ProtoField } from "./proto.ts";

export type TronVote = {
  readonly witness: string;
  readonly count: bigint;
};

/** Permission as the wire carries it — enum ids and operations bitmap kept raw for display. */
export type TronPermissionWire = {
  readonly type: number;
  readonly id: number;
  readonly name: string;
  readonly threshold: bigint;
  readonly parentId: number;
  readonly operations: Uint8Array;
  readonly keys: ReadonlyArray<{ readonly address: string; readonly weight: bigint }>;
};

export type TronContract =
  | {
      readonly type: "TransferContract";
      readonly owner: string;
      readonly to: string;
      readonly amount: bigint;
    }
  | {
      readonly type: "TransferAssetContract";
      readonly owner: string;
      readonly to: string;
      /** Asset_name as a decimal string ("1002000"). */
      readonly assetId: string;
      readonly amount: bigint;
    }
  | {
      readonly type: "VoteWitnessContract";
      readonly owner: string;
      readonly votes: ReadonlyArray<TronVote>;
      readonly support: boolean;
    }
  | { readonly type: "WithdrawBalanceContract"; readonly owner: string }
  | {
      readonly type: "TriggerSmartContract";
      readonly owner: string;
      readonly contract: string;
      readonly callValue: bigint;
      readonly data: Uint8Array;
      readonly callTokenValue: bigint;
      readonly tokenId: bigint;
    }
  | {
      readonly type: "FreezeBalanceV2Contract";
      readonly owner: string;
      readonly amount: bigint;
      readonly resource: number;
    }
  | {
      readonly type: "UnfreezeBalanceV2Contract";
      readonly owner: string;
      readonly amount: bigint;
      readonly resource: number;
    }
  | { readonly type: "WithdrawExpireUnfreezeContract"; readonly owner: string }
  | {
      readonly type: "DelegateResourceContract";
      readonly owner: string;
      readonly resource: number;
      readonly balance: bigint;
      readonly receiver: string;
      readonly lock: boolean;
      readonly lockPeriod: bigint;
    }
  | {
      readonly type: "UnDelegateResourceContract";
      readonly owner: string;
      readonly resource: number;
      readonly balance: bigint;
      readonly receiver: string;
    }
  | { readonly type: "CancelAllUnfreezeV2Contract"; readonly owner: string }
  | {
      readonly type: "AccountPermissionUpdateContract";
      readonly owner: string;
      readonly ownerPermission: TronPermissionWire;
      readonly witnessPermission?: TronPermissionWire;
      readonly actives: ReadonlyArray<TronPermissionWire>;
    };

const EMPTY = new Uint8Array(0);

const field = (fs: ReadonlyArray<ProtoField>, n: number): ProtoField | undefined =>
  fs.find((f) => f.field === n);

const all = (fs: ReadonlyArray<ProtoField>, n: number): ReadonlyArray<ProtoField> =>
  fs.filter((f) => f.field === n);

/** A field that must be present — a missing modeled scalar is absent only when defaulted. */
const required = (fs: ReadonlyArray<ProtoField>, n: number, what: string): ProtoField => {
  const f = field(fs, n);
  if (f === undefined) {
    malformed(`${what} is missing`);
  }
  return f;
};

const addressOf = (f: ProtoField | undefined, what: string): string => {
  const data = f !== undefined && f.wire === 2 ? f.data : undefined;
  if (data === undefined) {
    malformed(`${what} is missing`);
  }
  if (data.length !== 21 || data[0] !== TRON_ADDRESS_PREFIX) {
    malformed(`${what} is not a 21-byte TRON address`);
  }
  return tronAddressFromBytes(data);
};

const int64Of = (f: ProtoField | undefined, what: string): bigint => {
  if (f === undefined) {
    return 0n;
  }
  if (f.wire !== 0 || f.varint === undefined) {
    malformed(`${what} has the wrong wire type`);
  }
  if (f.varint >= 0x8000000000000000n) {
    malformed(`${what} is negative`);
  }
  return f.varint;
};

const int32Of = (f: ProtoField | undefined, what: string): number => {
  const v = int64Of(f, what);
  if (v > 0x7fffffffn) {
    malformed(`${what} exceeds int32`);
  }
  return Number(v);
};

const boolOf = (f: ProtoField | undefined, what: string): boolean => {
  if (f === undefined) {
    return false;
  }
  if (f.wire !== 0 || f.varint !== 1n) {
    malformed(`${what} is not a proto3 bool`);
  }
  return true;
};

const bytesOf = (f: ProtoField | undefined): Uint8Array => {
  if (f === undefined) {
    return EMPTY;
  }
  if (f.wire !== 2 || f.data === undefined) {
    malformed("bytes field has the wrong wire type");
  }
  return f.data;
};

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const stringOf = (f: ProtoField | undefined, what: string): string => {
  if (f === undefined) {
    return "";
  }
  const data = bytesOf(f);
  try {
    return utf8.decode(data);
  } catch {
    return malformed(`${what} is not UTF-8`);
  }
};

const asciiOf = (f: ProtoField | undefined, what: string): string => {
  const text = stringOf(f, what);
  for (const c of text) {
    if ((c.codePointAt(0) ?? 0) > 0x7f) {
      malformed(`${what} is not ASCII`);
    }
  }
  return text;
};

/**
 * The field's canonical encoding is the value re-encoded (a proto3 default drops out). Anything
 * else — an explicitly-encoded default, a non-minimal form the reader itself missed — is
 * non-canonical.
 */
const canonical = (f: ProtoField | undefined, encoded: Uint8Array | undefined): void => {
  if (f !== undefined && !equalBytes(f.bytes, encoded ?? EMPTY)) {
    malformed("non-canonical encoding");
  }
};

const encAddress = (n: number, address: string): Uint8Array =>
  requiredBytesField(n, tronAddressToBytes(address));

const encBytes = (n: number, data: Uint8Array): Uint8Array | undefined => bytesField(n, data);

const encInt = (n: number, value: bigint | number): Uint8Array | undefined => varintField(n, value);

const encBool = (n: number, value: boolean): Uint8Array | undefined =>
  value ? requiredVarintField(n, 1) : undefined;

type FieldSlot = { readonly field: number; readonly bytes: Uint8Array | undefined };

const slot = (field: number, bytes: Uint8Array | undefined): FieldSlot => ({ field, bytes });

const decodeVote = (f: ProtoField): { readonly vote: TronVote; readonly extra: ProtoExtra } => {
  const data =
    f.wire === 2 && f.data !== undefined ? f.data : malformed("vote has the wrong wire type");
  const fs = readFields(data);
  const witness = addressOf(required(fs, 1, "vote_address"), "vote_address");
  const count = int64Of(field(fs, 2), "vote_count");
  canonical(required(fs, 1, "vote_address"), encAddress(1, witness));
  canonical(field(fs, 2), encInt(2, count));
  return {
    vote: { witness, count },
    extra: collectExtra(fs, [1, 2]),
  };
};

const encodeVote = (vote: TronVote): Uint8Array =>
  encodeMessage([slot(1, encAddress(1, vote.witness)), slot(2, encInt(2, vote.count))]);

const decodeKey = (
  f: ProtoField,
): {
  readonly key: { readonly address: string; readonly weight: bigint };
  readonly extra: ProtoExtra;
} => {
  const data =
    f.wire === 2 && f.data !== undefined ? f.data : malformed("key has the wrong wire type");
  const fs = readFields(data);
  const address = addressOf(required(fs, 1, "key.address"), "key.address");
  const weight = int64Of(field(fs, 2), "key.weight");
  canonical(required(fs, 1, "key.address"), encAddress(1, address));
  canonical(field(fs, 2), encInt(2, weight));
  return {
    key: { address, weight },
    extra: collectExtra(fs, [1, 2]),
  };
};

const encodeKey = (key: { readonly address: string; readonly weight: bigint }): Uint8Array =>
  encodeMessage([slot(1, encAddress(1, key.address)), slot(2, encInt(2, key.weight))]);

const decodePermission = (
  f: ProtoField,
): { readonly permission: TronPermissionWire; readonly extra: ProtoExtra } => {
  const data =
    f.wire === 2 && f.data !== undefined ? f.data : malformed("permission has the wrong wire type");
  const fs = readFields(data, [7]);
  const type = int32Of(field(fs, 1), "permission.type");
  const id = int32Of(field(fs, 2), "permission.id");
  const name = stringOf(field(fs, 3), "permission_name");
  const threshold = int64Of(field(fs, 4), "permission.threshold");
  const parentId = int32Of(field(fs, 5), "permission.parent_id");
  const operations = bytesOf(field(fs, 6));
  const keys: Array<{ readonly address: string; readonly weight: bigint }> = [];
  const extras: ProtoField[] = [...collectExtra(fs, [1, 2, 3, 4, 5, 6, 7])];
  for (const kf of all(fs, 7)) {
    const { key, extra } = decodeKey(kf);
    keys.push(key);
    extras.push(...extra);
  }
  canonical(field(fs, 1), encInt(1, type));
  canonical(field(fs, 2), encInt(2, id));
  canonical(field(fs, 3), stringField(3, name));
  canonical(field(fs, 4), encInt(4, threshold));
  canonical(field(fs, 5), encInt(5, parentId));
  canonical(field(fs, 6), encBytes(6, operations));
  const permission = { type, id, name, threshold, parentId, operations, keys };
  return { permission, extra: extras };
};

const encodePermission = (p: TronPermissionWire): Uint8Array =>
  encodeMessage([
    slot(1, encInt(1, p.type)),
    slot(2, encInt(2, p.id)),
    slot(3, stringField(3, p.name)),
    slot(4, encInt(4, p.threshold)),
    slot(5, encInt(5, p.parentId)),
    slot(6, encBytes(6, p.operations)),
    ...p.keys.map((k) => slot(7, requiredBytesField(7, encodeKey(k)))),
  ]);

type Decoded = { readonly contract: TronContract; readonly extra: ProtoExtra };

const decoders: Readonly<Record<number, (value: Uint8Array) => Decoded>> = {
  1(value): Decoded {
    const fs = readFields(value);
    const owner = addressOf(required(fs, 1, "owner_address"), "owner_address");
    const to = addressOf(required(fs, 2, "to_address"), "to_address");
    const amount = int64Of(field(fs, 3), "amount");
    canonical(field(fs, 1), encAddress(1, owner));
    canonical(field(fs, 2), encAddress(2, to));
    canonical(field(fs, 3), encInt(3, amount));
    return {
      contract: { type: "TransferContract", owner, to, amount },
      extra: collectExtra(fs, [1, 2, 3]),
    };
  },
  2(value): Decoded {
    const fs = readFields(value);
    const assetId = asciiOf(required(fs, 1, "asset_name"), "asset_name");
    const owner = addressOf(required(fs, 2, "owner_address"), "owner_address");
    const to = addressOf(required(fs, 3, "to_address"), "to_address");
    const amount = int64Of(field(fs, 4), "amount");
    canonical(field(fs, 1), stringField(1, assetId));
    canonical(field(fs, 2), encAddress(2, owner));
    canonical(field(fs, 3), encAddress(3, to));
    canonical(field(fs, 4), encInt(4, amount));
    return {
      contract: { type: "TransferAssetContract", owner, to, assetId, amount },
      extra: collectExtra(fs, [1, 2, 3, 4]),
    };
  },
  4(value): Decoded {
    const fs = readFields(value, [2]);
    const owner = addressOf(required(fs, 1, "owner_address"), "owner_address");
    const votes: TronVote[] = [];
    const extras: ProtoField[] = [...collectExtra(fs, [1, 2, 3])];
    for (const vf of all(fs, 2)) {
      const { vote, extra } = decodeVote(vf);
      votes.push(vote);
      extras.push(...extra);
    }
    const support = boolOf(field(fs, 3), "support");
    canonical(field(fs, 1), encAddress(1, owner));
    canonical(field(fs, 3), encBool(3, support));
    return {
      contract: { type: "VoteWitnessContract", owner, votes, support },
      extra: extras,
    };
  },
  13(value): Decoded {
    const fs = readFields(value);
    const owner = addressOf(required(fs, 1, "owner_address"), "owner_address");
    canonical(field(fs, 1), encAddress(1, owner));
    return {
      contract: { type: "WithdrawBalanceContract", owner },
      extra: collectExtra(fs, [1]),
    };
  },
  31(value): Decoded {
    const fs = readFields(value);
    const owner = addressOf(required(fs, 1, "owner_address"), "owner_address");
    const contract = addressOf(required(fs, 2, "contract_address"), "contract_address");
    const callValue = int64Of(field(fs, 3), "call_value");
    const data = bytesOf(field(fs, 4));
    const callTokenValue = int64Of(field(fs, 5), "call_token_value");
    const tokenId = int64Of(field(fs, 6), "token_id");
    canonical(field(fs, 1), encAddress(1, owner));
    canonical(field(fs, 2), encAddress(2, contract));
    canonical(field(fs, 3), encInt(3, callValue));
    canonical(field(fs, 4), encBytes(4, data));
    canonical(field(fs, 5), encInt(5, callTokenValue));
    canonical(field(fs, 6), encInt(6, tokenId));
    return {
      contract: {
        type: "TriggerSmartContract",
        owner,
        contract,
        callValue,
        data,
        callTokenValue,
        tokenId,
      },
      extra: collectExtra(fs, [1, 2, 3, 4, 5, 6]),
    };
  },
  54(value): Decoded {
    const fs = readFields(value);
    const owner = addressOf(required(fs, 1, "owner_address"), "owner_address");
    const amount = int64Of(field(fs, 2), "frozen_balance");
    const resource = int32Of(field(fs, 3), "resource");
    canonical(field(fs, 1), encAddress(1, owner));
    canonical(field(fs, 2), encInt(2, amount));
    canonical(field(fs, 3), encInt(3, resource));
    return {
      contract: { type: "FreezeBalanceV2Contract", owner, amount, resource },
      extra: collectExtra(fs, [1, 2, 3]),
    };
  },
  55(value): Decoded {
    const fs = readFields(value);
    const owner = addressOf(required(fs, 1, "owner_address"), "owner_address");
    const amount = int64Of(field(fs, 2), "unfreeze_balance");
    const resource = int32Of(field(fs, 3), "resource");
    canonical(field(fs, 1), encAddress(1, owner));
    canonical(field(fs, 2), encInt(2, amount));
    canonical(field(fs, 3), encInt(3, resource));
    return {
      contract: { type: "UnfreezeBalanceV2Contract", owner, amount, resource },
      extra: collectExtra(fs, [1, 2, 3]),
    };
  },
  56(value): Decoded {
    const fs = readFields(value);
    const owner = addressOf(required(fs, 1, "owner_address"), "owner_address");
    canonical(field(fs, 1), encAddress(1, owner));
    return {
      contract: { type: "WithdrawExpireUnfreezeContract", owner },
      extra: collectExtra(fs, [1]),
    };
  },
  57(value): Decoded {
    const fs = readFields(value);
    const owner = addressOf(required(fs, 1, "owner_address"), "owner_address");
    const resource = int32Of(field(fs, 2), "resource");
    const balance = int64Of(field(fs, 3), "balance");
    const receiver = addressOf(required(fs, 4, "receiver_address"), "receiver_address");
    const lock = boolOf(field(fs, 5), "lock");
    const lockPeriod = int64Of(field(fs, 6), "lock_period");
    canonical(field(fs, 1), encAddress(1, owner));
    canonical(field(fs, 2), encInt(2, resource));
    canonical(field(fs, 3), encInt(3, balance));
    canonical(field(fs, 4), encAddress(4, receiver));
    canonical(field(fs, 5), encBool(5, lock));
    canonical(field(fs, 6), encInt(6, lockPeriod));
    return {
      contract: {
        type: "DelegateResourceContract",
        owner,
        resource,
        balance,
        receiver,
        lock,
        lockPeriod,
      },
      extra: collectExtra(fs, [1, 2, 3, 4, 5, 6]),
    };
  },
  58(value): Decoded {
    const fs = readFields(value);
    const owner = addressOf(required(fs, 1, "owner_address"), "owner_address");
    const resource = int32Of(field(fs, 2), "resource");
    const balance = int64Of(field(fs, 3), "balance");
    const receiver = addressOf(required(fs, 4, "receiver_address"), "receiver_address");
    canonical(field(fs, 1), encAddress(1, owner));
    canonical(field(fs, 2), encInt(2, resource));
    canonical(field(fs, 3), encInt(3, balance));
    canonical(field(fs, 4), encAddress(4, receiver));
    return {
      contract: { type: "UnDelegateResourceContract", owner, resource, balance, receiver },
      extra: collectExtra(fs, [1, 2, 3, 4]),
    };
  },
  59(value): Decoded {
    const fs = readFields(value);
    const owner = addressOf(required(fs, 1, "owner_address"), "owner_address");
    canonical(field(fs, 1), encAddress(1, owner));
    return {
      contract: { type: "CancelAllUnfreezeV2Contract", owner },
      extra: collectExtra(fs, [1]),
    };
  },
  46(value): Decoded {
    const fs = readFields(value, [4]);
    const owner = addressOf(required(fs, 1, "owner_address"), "owner_address");
    const extras: ProtoField[] = [...collectExtra(fs, [1, 2, 3, 4])];
    const ownerF = required(fs, 2, "owner permission");
    const { permission: ownerPermission, extra: ownerExtra } = decodePermission(ownerF);
    extras.push(...ownerExtra);
    const witnessF = field(fs, 3);
    let witnessPermission: TronPermissionWire | undefined;
    if (witnessF !== undefined) {
      const { permission, extra } = decodePermission(witnessF);
      witnessPermission = permission;
      extras.push(...extra);
    }
    const actives: TronPermissionWire[] = [];
    for (const af of all(fs, 4)) {
      const { permission, extra } = decodePermission(af);
      actives.push(permission);
      extras.push(...extra);
    }
    canonical(field(fs, 1), encAddress(1, owner));
    const contract: TronContract = {
      type: "AccountPermissionUpdateContract",
      owner,
      ownerPermission,
      ...(witnessPermission === undefined ? {} : { witnessPermission }),
      actives,
    };
    return { contract, extra: extras };
  },
};

/**
 * The modeled decode of a contract `parameter.value`. Undefined for a contract type the wallet does
 * not model — the caller blinds it as `tron-contract`. Unknown fields anywhere inside the value
 * (this message or a nested Vote/Key/Permission) come back in `extra` for blind detection;
 * canonicality of every scalar field was already enforced.
 */
export const decodeTronContract = (typeId: number, value: Uint8Array): Decoded | undefined =>
  decoders[typeId]?.(value);

/** Canonical encode of a modeled contract — the inverse of `decodeTronContract` on clean input. */
// oxlint-disable-next-line typescript/consistent-return -- the switch over TronContract is exhaustive; every case returns
export const encodeTronContract = (contract: TronContract): Uint8Array => {
  switch (contract.type) {
    case "TransferContract":
      return encodeMessage([
        slot(1, encAddress(1, contract.owner)),
        slot(2, encAddress(2, contract.to)),
        slot(3, encInt(3, contract.amount)),
      ]);
    case "TransferAssetContract":
      return encodeMessage([
        slot(1, stringField(1, contract.assetId)),
        slot(2, encAddress(2, contract.owner)),
        slot(3, encAddress(3, contract.to)),
        slot(4, encInt(4, contract.amount)),
      ]);
    case "VoteWitnessContract":
      return encodeMessage([
        slot(1, encAddress(1, contract.owner)),
        ...contract.votes.map((v) => slot(2, requiredBytesField(2, encodeVote(v)))),
        slot(3, encBool(3, contract.support)),
      ]);
    case "WithdrawBalanceContract":
      return encodeMessage([slot(1, encAddress(1, contract.owner))]);
    case "TriggerSmartContract":
      return encodeMessage([
        slot(1, encAddress(1, contract.owner)),
        slot(2, encAddress(2, contract.contract)),
        slot(3, encInt(3, contract.callValue)),
        slot(4, encBytes(4, contract.data)),
        slot(5, encInt(5, contract.callTokenValue)),
        slot(6, encInt(6, contract.tokenId)),
      ]);
    case "FreezeBalanceV2Contract":
    case "UnfreezeBalanceV2Contract":
      return encodeMessage([
        slot(1, encAddress(1, contract.owner)),
        slot(2, encInt(2, contract.amount)),
        slot(3, encInt(3, contract.resource)),
      ]);
    case "WithdrawExpireUnfreezeContract":
    case "CancelAllUnfreezeV2Contract":
      return encodeMessage([slot(1, encAddress(1, contract.owner))]);
    case "DelegateResourceContract":
      return encodeMessage([
        slot(1, encAddress(1, contract.owner)),
        slot(2, encInt(2, contract.resource)),
        slot(3, encInt(3, contract.balance)),
        slot(4, encAddress(4, contract.receiver)),
        slot(5, encBool(5, contract.lock)),
        slot(6, encInt(6, contract.lockPeriod)),
      ]);
    case "UnDelegateResourceContract":
      return encodeMessage([
        slot(1, encAddress(1, contract.owner)),
        slot(2, encInt(2, contract.resource)),
        slot(3, encInt(3, contract.balance)),
        slot(4, encAddress(4, contract.receiver)),
      ]);
    case "AccountPermissionUpdateContract":
      return encodeMessage([
        slot(1, encAddress(1, contract.owner)),
        slot(2, requiredBytesField(2, encodePermission(contract.ownerPermission))),
        slot(
          3,
          contract.witnessPermission === undefined
            ? undefined
            : requiredBytesField(3, encodePermission(contract.witnessPermission)),
        ),
        ...contract.actives.map((p) => slot(4, requiredBytesField(4, encodePermission(p)))),
      ]);
  }
};
