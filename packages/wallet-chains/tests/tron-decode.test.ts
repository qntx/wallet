/**
 * `decodeTron` / `normalizeTron` semantics: one intent assertion per generated vector, every
 * malformed-wire rule, every semantic refusal, every blind cause, memo/permissionId display, and
 * the tron.message content rules.
 */
// oxlint-disable vitest/expect-expect -- malformed/blind factories wrap the expect calls
// oxlint-disable vitest/no-conditional-expect -- the malformed factories expect inside catch
// oxlint-disable vitest/valid-title -- test factories name their cases
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { ChainError } from "../src/index.ts";
import type { SignRequest } from "../src/index.ts";
import { tronAddressToBytes } from "../src/tron/address.ts";
import { encodeTronContract } from "../src/tron/contracts.ts";
import { decodeTron } from "../src/tron/decode.ts";
import { normalizeTron } from "../src/tron/index.ts";
import {
  bytesField,
  encodeMessage,
  requiredBytesField,
  requiredVarintField,
  stringField,
  varintField,
} from "../src/tron/proto.ts";
import { decodeTronRawData, encodeTronRawData } from "../src/tron/raw.ts";
import { ACCOUNT, OWNER, tronVectors, txRequest } from "./tron.ts";

const ALICE = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC";
const BOB = "THRF3GuPnvvPzKoaT8pJex5XHmo8NNbCb3";
const CAROL = "TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const hex = (h: string): Uint8Array => hexToBytes(h);
const of = (...b: number[]): Uint8Array => Uint8Array.from(b);

const vector = (name: string) => {
  const v = tronVectors.transactions.find((t) => t.name === name);
  if (v === undefined) {
    throw new Error(`missing vector ${name}`);
  }
  return v;
};

const intent = (name: string) => decodeTron(txRequest(vector(name).rawDataHex), OWNER);

const refuse = (run: () => unknown, match: RegExp | string): void => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).code).toBe("invalid-request");
    expect((error as ChainError).message).toMatch(match);
    return;
  }
  throw new Error("expected ChainError");
};

describe("generated vectors", () => {
  it("trx-transfer: a full-verifiability sun transfer", () => {
    const i = intent("trx-transfer");
    expect(i.family).toBe("tron");
    expect(i.summary).toBe("transfer");
    expect(i.verifiability).toBe("full");
    expect(i.blind).toBeUndefined();
    expect(i.outflows).toStrictEqual([
      {
        to: ALICE,
        amount: { asset: "sun", amount: "1000000", decimals: 6, symbol: "TRX" },
        verified: true,
      },
    ]);
    expect(i.tron?.contractType).toBe("TransferContract");
    expect(i.tron?.expiration).toBe(1767225660000);
    expect(i.tron?.permissionId).toBeUndefined();
    expect(i.tron?.memo).toBeUndefined();
    expect(i.fee).toBeUndefined();
  });

  it("trx-transfer-memo: readable memo shows as text", () => {
    const i = intent("trx-transfer-memo");
    expect(i.tron?.memo).toStrictEqual({ kind: "text", text: "tron fixed-vector memo" });
  });

  it("trx-transfer-permission-2: permissionId surfaces", () => {
    const i = intent("trx-transfer-permission-2");
    expect(i.tron?.permissionId).toBe(2);
    expect(i.summary).toBe("transfer");
  });

  it("trc20-transfer: a table-verified USDT transfer", () => {
    const i = intent("trc20-transfer");
    expect(i.summary).toBe("transfer");
    expect(i.verifiability).toBe("full");
    expect(i.outflows).toStrictEqual([
      {
        to: ALICE,
        amount: { asset: USDT, amount: "10000000", symbol: "USDT", decimals: 6 },
        verified: true,
      },
    ]);
    expect(i.contract).toStrictEqual({
      address: USDT,
      created: false,
      selector: "0xa9059cbb",
      symbol: "USDT",
    });
    expect(i.fee).toStrictEqual({
      max: { asset: "sun", amount: "30000000", decimals: 6, symbol: "TRX" },
    });
  });

  it("trc20-transfer-self: outflow back to the owner", () => {
    const i = intent("trc20-transfer-self");
    expect(i.outflows[0]?.to).toBe(OWNER);
    expect(i.verifiability).toBe("full");
  });

  it("trc20-approve: a finite allowance", () => {
    const i = intent("trc20-approve");
    expect(i.summary).toBe("approve");
    expect(i.verifiability).toBe("partial");
    expect(i.approvals).toStrictEqual([
      {
        kind: "allowance",
        spender: BOB,
        amount: { asset: USDT, amount: "5000000", symbol: "USDT", decimals: 6 },
        change: "set",
        unlimited: false,
        verified: true,
      },
    ]);
  });

  it("trc20-approve-unlimited: an unlimited allowance", () => {
    const i = intent("trc20-approve-unlimited");
    expect(i.approvals[0]).toMatchObject({ kind: "allowance", spender: BOB, unlimited: true });
  });

  it("trc10-transfer: unverified asset, partial", () => {
    const i = intent("trc10-transfer");
    expect(i.summary).toBe("transfer");
    expect(i.verifiability).toBe("partial");
    expect(i.outflows).toStrictEqual([
      { to: ALICE, amount: { asset: "trc10:1002000", amount: "500" }, verified: false },
    ]);
  });

  it("freeze-v2-energy / freeze-v2-bandwidth: stake actions", () => {
    const energy = intent("freeze-v2-energy");
    expect(energy.summary).toBe("stake");
    expect(energy.staking).toStrictEqual([
      {
        kind: "tron-freeze",
        amount: { asset: "sun", amount: "2000000", decimals: 6, symbol: "TRX" },
        resource: "energy",
      },
    ]);
    const bandwidth = intent("freeze-v2-bandwidth");
    expect(bandwidth.staking?.[0]).toMatchObject({ kind: "tron-freeze", resource: "bandwidth" });
  });

  it("unfreeze-v2-energy", () => {
    expect(intent("unfreeze-v2-energy").staking).toStrictEqual([
      {
        kind: "tron-unfreeze",
        amount: { asset: "sun", amount: "1000000", decimals: 6, symbol: "TRX" },
        resource: "energy",
      },
    ]);
  });

  it("delegate-energy: unlocked delegation", () => {
    const i = intent("delegate-energy");
    expect(i.staking).toStrictEqual([
      {
        kind: "tron-delegate",
        receiver: ALICE,
        amount: { asset: "sun", amount: "4000000", decimals: 6, symbol: "TRX" },
        resource: "energy",
      },
    ]);
  });

  it("delegate-bandwidth-locked: lock with a block count", () => {
    const i = intent("delegate-bandwidth-locked");
    expect(i.staking).toStrictEqual([
      {
        kind: "tron-delegate",
        receiver: BOB,
        amount: { asset: "sun", amount: "5000000", decimals: 6, symbol: "TRX" },
        resource: "bandwidth",
        lock: { blocks: "28800" },
      },
    ]);
  });

  it("undelegate-energy", () => {
    expect(intent("undelegate-energy").staking).toStrictEqual([
      {
        kind: "tron-undelegate",
        receiver: ALICE,
        amount: { asset: "sun", amount: "2000000", decimals: 6, symbol: "TRX" },
        resource: "energy",
      },
    ]);
  });

  it("withdraw-expire-unfreeze / cancel-all-unfreeze-v2 / withdraw-balance", () => {
    expect(intent("withdraw-expire-unfreeze").staking).toStrictEqual([
      { kind: "tron-withdraw-unfrozen" },
    ]);
    expect(intent("cancel-all-unfreeze-v2").staking).toStrictEqual([
      { kind: "tron-cancel-unfreeze" },
    ]);
    expect(intent("withdraw-balance").staking).toStrictEqual([{ kind: "tron-claim-rewards" }]);
  });

  it("vote-witness: two votes", () => {
    const i = intent("vote-witness");
    expect(i.summary).toBe("stake");
    expect(i.staking).toStrictEqual([
      {
        kind: "tron-vote",
        votes: [
          { witness: ALICE, count: "3" },
          { witness: BOB, count: "7" },
        ],
      },
    ]);
  });

  it("account-permission-update: blind with the full permission content", () => {
    const i = intent("account-permission-update");
    expect(i.summary).toBe("authorization");
    expect(i.verifiability).toBe("partial");
    expect(i.blind).toBe("tron-permission-update");
    const update = i.tron?.permissionUpdate;
    expect(update?.owner).toMatchObject({
      type: "owner",
      name: "owner",
      threshold: "1",
      keys: [{ address: CAROL, weight: "1" }],
    });
    expect(update?.owner.operations).toBeUndefined();
    expect(update?.witness).toBeUndefined();
    expect(update?.actives).toHaveLength(1);
    expect(update?.actives[0]).toMatchObject({
      type: "active",
      name: "active0",
      threshold: "2",
      operations: `0x02${"00".repeat(2)}80${"00".repeat(28)}`,
      keys: [
        { address: OWNER, weight: "1" },
        { address: ALICE, weight: "1" },
      ],
    });
  });

  it("trigger-call-value: opaque call with the TRX outflow to the contract", () => {
    const i = intent("trigger-call-value");
    expect(i.summary).toBe("contract-call");
    expect(i.verifiability).toBe("opaque");
    expect(i.blind).toBeUndefined();
    expect(i.outflows).toStrictEqual([
      {
        to: CAROL,
        amount: { asset: "sun", amount: "1000000", decimals: 6, symbol: "TRX" },
        verified: true,
      },
    ]);
    expect(i.contract?.address).toBe(CAROL);
  });

  it("trigger-token-unknown-selector: token-function near miss", () => {
    const i = intent("trigger-token-unknown-selector");
    expect(i.summary).toBe("contract-call");
    expect(i.verifiability).toBe("opaque");
    expect(i.blind).toBe("token-function");
    expect(i.contract?.symbol).toBe("USDT");
  });

  it("unsupported-account-update: blind tron-contract naming the type", () => {
    const i = intent("unsupported-account-update");
    expect(i.summary).toBe("contract-call");
    expect(i.verifiability).toBe("opaque");
    expect(i.blind).toBe("tron-contract");
    expect(i.tron?.contractType).toBe("AccountUpdateContract");
  });

  it("refuses an owner that is not the signer", () => {
    refuse(() => decodeTron(txRequest(vector("trx-transfer").rawDataHex), ALICE), /owner/);
  });
});

// -- byte-level malformed and blind variants -----------------------------------

const RAW_TRANSFER = hex(vector("trx-transfer").rawDataHex);
const raw = decodeTronRawData(RAW_TRANSFER);
const TS = raw.timestamp ?? 0n;

const extraField = (field: number, slice: Uint8Array): Uint8Array =>
  encodeTronRawData({
    ...raw,
    extra: [{ field, wire: 2, bytes: slice, varint: undefined, data: slice }],
  });

const contractExtra = (field: number, slice: Uint8Array): Uint8Array =>
  encodeTronRawData({
    ...raw,
    contract: {
      ...raw.contract,
      extra: [{ field, wire: 2, bytes: slice, varint: undefined, data: slice }],
    },
  });

const contractSlot = (typeId: number, name: string, value: Uint8Array): Uint8Array =>
  encodeMessage([
    { field: 1, bytes: varintField(1, typeId) },
    {
      field: 2,
      bytes: requiredBytesField(
        2,
        encodeMessage([
          { field: 1, bytes: stringField(1, `type.googleapis.com/protocol.${name}`) },
          { field: 2, bytes: bytesField(2, value) },
        ]),
      ),
    },
  ]);

const rawFor = (contractBytes: Uint8Array, contractField = 11): Uint8Array =>
  encodeMessage([
    { field: 1, bytes: requiredBytesField(1, raw.refBlockBytes) },
    { field: 4, bytes: requiredBytesField(4, raw.refBlockHash) },
    { field: 8, bytes: varintField(8, raw.expiration) },
    { field: 11, bytes: requiredBytesField(contractField, contractBytes) },
    { field: 14, bytes: varintField(14, TS) },
  ]);

const valueFor = (contract: Parameters<typeof encodeTronContract>[0]): Uint8Array =>
  encodeTronContract(contract);

const transferValue = (mutate: (v: Uint8Array) => Uint8Array): Uint8Array => {
  const out = encodeTronRawData({
    ...raw,
    contract: { ...raw.contract, value: mutate(raw.contract.value) },
  });
  return out;
};

describe("malformed wire input", () => {
  const malformed = (name: string, run: () => unknown): void => {
    it(name, () => {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(ChainError);
        expect((error as ChainError).code).toBe("invalid-request");
        return;
      }
      throw new Error("expected ChainError");
    });
  };

  const malformedMatching = (name: string, run: () => unknown, match: RegExp): void => {
    it(name, () => {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(ChainError);
        expect((error as ChainError).code).toBe("invalid-request");
        expect((error as ChainError).message).toMatch(match);
        return;
      }
      throw new Error("expected ChainError");
    });
  };

  malformed("zero contracts", () =>
    decodeTronRawData(
      encodeMessage([
        { field: 1, bytes: requiredBytesField(1, raw.refBlockBytes) },
        { field: 4, bytes: requiredBytesField(4, raw.refBlockHash) },
        { field: 8, bytes: varintField(8, raw.expiration) },
        { field: 14, bytes: varintField(14, TS) },
      ]),
    ),
  );

  malformedMatching(
    "two contracts",
    () =>
      decodeTronRawData(
        encodeMessage([
          { field: 1, bytes: requiredBytesField(1, raw.refBlockBytes) },
          { field: 4, bytes: requiredBytesField(4, raw.refBlockHash) },
          { field: 8, bytes: varintField(8, raw.expiration) },
          {
            field: 11,
            bytes: requiredBytesField(11, contractSlot(1, "TransferContract", raw.contract.value)),
          },
          {
            field: 11,
            bytes: requiredBytesField(11, contractSlot(1, "TransferContract", raw.contract.value)),
          },
          { field: 14, bytes: varintField(14, TS) },
        ]),
      ),
    /exactly one is supported/,
  );

  malformed("non-minimal varint", () => {
    const bytes = new Uint8Array(RAW_TRANSFER);
    // find the expiration varint field 8 tag 0x40 and replace value with 0x80 0x00
    bytes.set([0x80, 0x00], bytes.indexOf(0x40) + 1);
    decodeTronRawData(bytes.subarray(0, bytes.indexOf(0x40) + 3));
  });

  malformed("duplicate non-repeated field", () =>
    decodeTronRawData(
      encodeMessage([
        { field: 1, bytes: requiredBytesField(1, raw.refBlockBytes) },
        { field: 1, bytes: requiredBytesField(1, raw.refBlockBytes) },
        { field: 4, bytes: requiredBytesField(4, raw.refBlockHash) },
        { field: 8, bytes: varintField(8, raw.expiration) },
        {
          field: 11,
          bytes: requiredBytesField(11, contractSlot(1, "TransferContract", raw.contract.value)),
        },
        { field: 14, bytes: varintField(14, TS) },
      ]),
    ),
  );

  malformed("descending fields", () =>
    decodeTronRawData(
      (() => {
        const out = new Uint8Array(RAW_TRANSFER.length);
        out.set(RAW_TRANSFER.subarray(4), 0);
        out.set(RAW_TRANSFER.subarray(0, 4), RAW_TRANSFER.length - 4);
        return out;
      })(),
    ),
  );

  malformed("wrong wire type on a varint field", () =>
    decodeTronRawData(
      encodeMessage([
        { field: 1, bytes: requiredBytesField(1, raw.refBlockBytes) },
        { field: 4, bytes: requiredBytesField(4, raw.refBlockHash) },
        { field: 8, bytes: requiredBytesField(8, of(1)) }, // expiration as bytes
        {
          field: 11,
          bytes: requiredBytesField(11, contractSlot(1, "TransferContract", raw.contract.value)),
        },
        { field: 14, bytes: varintField(14, TS) },
      ]),
    ),
  );

  malformed("truncated input", () => decodeTronRawData(RAW_TRANSFER.subarray(0, 40)));

  malformed("trailing garbage", () => {
    const bad = new Uint8Array(RAW_TRANSFER.length + 1);
    bad.set(RAW_TRANSFER);
    bad[bad.length - 1] = 0x80;
    decodeTronRawData(bad);
  });

  malformed("explicitly-encoded proto3 default", () =>
    decodeTronRawData(
      encodeMessage([
        { field: 1, bytes: requiredBytesField(1, raw.refBlockBytes) },
        { field: 4, bytes: requiredBytesField(4, raw.refBlockHash) },
        { field: 8, bytes: varintField(8, raw.expiration) },
        { field: 10, bytes: requiredBytesField(10, new Uint8Array(0)) }, // empty memo encoded
        {
          field: 11,
          bytes: requiredBytesField(11, contractSlot(1, "TransferContract", raw.contract.value)),
        },
        { field: 14, bytes: varintField(14, TS) },
      ]),
    ),
  );

  malformed("negative int64", () => {
    // expiration = -1 as int64 (10-byte varint 2^64-1)
    const neg = of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01);
    decodeTronRawData(
      encodeMessage([
        { field: 1, bytes: requiredBytesField(1, raw.refBlockBytes) },
        { field: 4, bytes: requiredBytesField(4, raw.refBlockHash) },
        { field: 8, bytes: new Uint8Array([0x40, ...neg]) },
        {
          field: 11,
          bytes: requiredBytesField(11, contractSlot(1, "TransferContract", raw.contract.value)),
        },
        { field: 14, bytes: varintField(14, TS) },
      ]),
    );
  });

  malformed("address too short", () =>
    decodeTron(
      {
        kind: "tron.transaction",
        network: "tron:728126428",
        account: ACCOUNT,
        rawData: rawFor(
          contractSlot(
            1,
            "TransferContract",
            encodeMessage([
              { field: 1, bytes: requiredBytesField(1, tronAddressToBytes(OWNER).subarray(0, 20)) },
              { field: 2, bytes: requiredBytesField(2, tronAddressToBytes(ALICE)) },
              { field: 3, bytes: varintField(3, 1n) },
            ]),
          ),
        ),
      },
      OWNER,
    ),
  );

  malformed("address with a 0x42 prefix", () => {
    const bad = tronAddressToBytes(OWNER);
    bad[0] = 0x42;
    decodeTron(
      {
        kind: "tron.transaction",
        network: "tron:728126428",
        account: ACCOUNT,
        rawData: rawFor(
          contractSlot(
            1,
            "TransferContract",
            encodeMessage([
              { field: 1, bytes: requiredBytesField(1, bad) },
              { field: 2, bytes: requiredBytesField(2, tronAddressToBytes(ALICE)) },
              { field: 3, bytes: varintField(3, 1n) },
            ]),
          ),
        ),
      },
      OWNER,
    );
  });

  malformed("wrong type_url for a known type", () =>
    decodeTronRawData(rawFor(contractSlot(1, "VoteWitnessContract", raw.contract.value))),
  );

  malformed("an extra field inside the Any", () =>
    decodeTronRawData(
      rawFor(
        encodeMessage([
          { field: 1, bytes: varintField(1, 1) },
          {
            field: 2,
            bytes: requiredBytesField(
              2,
              encodeMessage([
                {
                  field: 1,
                  bytes: stringField(1, "type.googleapis.com/protocol.TransferContract"),
                },
                { field: 2, bytes: bytesField(2, raw.contract.value) },
                { field: 3, bytes: varintField(3, 1n) },
              ]),
            ),
          },
        ]),
      ),
    ),
  );
});

describe("semantic refusals", () => {
  const request = (typeId: number, name: string, value: Uint8Array): SignRequest => ({
    kind: "tron.transaction",
    network: "tron:728126428",
    account: ACCOUNT,
    rawData: rawFor(contractSlot(typeId, name, value)),
  });

  it("refuses a zero-amount TRX transfer", () => {
    // amount absent on the wire decodes to 0 — refused semantically, not malformed
    const value = encodeMessage([
      { field: 1, bytes: requiredBytesField(1, tronAddressToBytes(OWNER)) },
      { field: 2, bytes: requiredBytesField(2, tronAddressToBytes(ALICE)) },
    ]);
    refuse(() => decodeTron(request(1, "TransferContract", value), OWNER), /zero/);
  });

  it("refuses a zero-amount freeze", () => {
    const value = encodeMessage([
      { field: 1, bytes: requiredBytesField(1, tronAddressToBytes(OWNER)) },
    ]);
    refuse(() => decodeTron(request(54, "FreezeBalanceV2Contract", value), OWNER), /zero/);
  });

  it("refuses a zero delegate balance", () => {
    const value = encodeMessage([
      { field: 1, bytes: requiredBytesField(1, tronAddressToBytes(OWNER)) },
      { field: 4, bytes: requiredBytesField(4, tronAddressToBytes(ALICE)) },
    ]);
    refuse(() => decodeTron(request(57, "DelegateResourceContract", value), OWNER), /zero/);
  });

  it("refuses a non-numeric TRC-10 asset id", () => {
    const value = encodeMessage([
      { field: 1, bytes: stringField(1, "abc") },
      { field: 2, bytes: requiredBytesField(2, tronAddressToBytes(OWNER)) },
      { field: 3, bytes: requiredBytesField(3, tronAddressToBytes(ALICE)) },
      { field: 4, bytes: varintField(4, 5n) },
    ]);
    refuse(() => decodeTron(request(2, "TransferAssetContract", value), OWNER), /asset/);
  });

  it("refuses a TRC-10 asset id of 0", () => {
    const value = encodeMessage([
      { field: 1, bytes: stringField(1, "0") },
      { field: 2, bytes: requiredBytesField(2, tronAddressToBytes(OWNER)) },
      { field: 3, bytes: requiredBytesField(3, tronAddressToBytes(ALICE)) },
      { field: 4, bytes: varintField(4, 5n) },
    ]);
    refuse(() => decodeTron(request(2, "TransferAssetContract", value), OWNER), /asset/);
  });

  it("refuses call_token_value without token_id", () => {
    const value = encodeTronContract({
      type: "TriggerSmartContract",
      owner: OWNER,
      contract: CAROL,
      callValue: 0n,
      data: new Uint8Array(0),
      callTokenValue: 7n,
      tokenId: 0n,
    });
    const req: SignRequest = {
      kind: "tron.transaction",
      network: "tron:728126428",
      account: ACCOUNT,
      rawData: encodeMessage([
        { field: 1, bytes: requiredBytesField(1, raw.refBlockBytes) },
        { field: 4, bytes: requiredBytesField(4, raw.refBlockHash) },
        { field: 8, bytes: varintField(8, raw.expiration) },
        {
          field: 11,
          bytes: requiredBytesField(11, contractSlot(31, "TriggerSmartContract", value)),
        },
        { field: 14, bytes: varintField(14, TS) },
        { field: 18, bytes: varintField(18, 1000000n) },
      ]),
    };
    refuse(() => decodeTron(req, OWNER), /token_id/);
  });

  it("refuses a trigger without fee_limit", () => {
    const value = encodeTronContract({
      type: "TriggerSmartContract",
      owner: OWNER,
      contract: CAROL,
      callValue: 0n,
      data: new Uint8Array(0),
      callTokenValue: 0n,
      tokenId: 0n,
    });
    refuse(() => decodeTron(request(31, "TriggerSmartContract", value), OWNER), /fee/);
  });

  it("refuses empty and >30 vote lists and zero counts", () => {
    refuse(
      () =>
        decodeTron(
          request(
            4,
            "VoteWitnessContract",
            valueFor({ type: "VoteWitnessContract", owner: OWNER, votes: [], support: false }),
          ),
          OWNER,
        ),
      /vote/,
    );
    const thirtyOne = Array.from({ length: 31 }, (_, i) => ({
      witness: ALICE,
      count: BigInt(i + 1),
    }));
    refuse(
      () =>
        decodeTron(
          request(
            4,
            "VoteWitnessContract",
            valueFor({
              type: "VoteWitnessContract",
              owner: OWNER,
              votes: thirtyOne,
              support: false,
            }),
          ),
          OWNER,
        ),
      /vote/,
    );
    refuse(
      () =>
        decodeTron(
          request(
            4,
            "VoteWitnessContract",
            valueFor({
              type: "VoteWitnessContract",
              owner: OWNER,
              votes: [{ witness: ALICE, count: 0n }],
              support: false,
            }),
          ),
          OWNER,
        ),
      /vote/,
    );
  });

  it("refuses empty and >8 actives", () => {
    const permission = {
      type: 2,
      id: 2,
      name: "a",
      threshold: 1n,
      parentId: 0,
      operations: new Uint8Array(32),
      keys: [{ address: ALICE, weight: 1n }],
    };
    const ownerPermission = {
      ...permission,
      type: 0,
      name: "owner",
      operations: new Uint8Array(0),
    };
    refuse(
      () =>
        decodeTron(
          request(
            46,
            "AccountPermissionUpdateContract",
            valueFor({
              type: "AccountPermissionUpdateContract",
              owner: OWNER,
              ownerPermission,
              actives: [],
            }),
          ),
          OWNER,
        ),
      /active/,
    );
    refuse(
      () =>
        decodeTron(
          request(
            46,
            "AccountPermissionUpdateContract",
            valueFor({
              type: "AccountPermissionUpdateContract",
              owner: OWNER,
              ownerPermission,
              actives: Array.from({ length: 9 }, () => permission),
            }),
          ),
          OWNER,
        ),
      /active/,
    );
  });

  it("refuses a permission with more than 5 keys", () => {
    const permission = {
      type: 0,
      id: 2,
      name: "owner",
      threshold: 1n,
      parentId: 0,
      operations: new Uint8Array(0),
      keys: [
        { address: ALICE, weight: 1n },
        { address: BOB, weight: 1n },
        { address: CAROL, weight: 1n },
        { address: OWNER, weight: 1n },
        { address: ALICE, weight: 1n },
        { address: BOB, weight: 1n },
      ],
    };
    refuse(
      () =>
        decodeTron(
          request(
            46,
            "AccountPermissionUpdateContract",
            valueFor({
              type: "AccountPermissionUpdateContract",
              owner: OWNER,
              ownerPermission: permission,
              actives: [
                {
                  ...permission,
                  type: 2,
                  operations: new Uint8Array(32),
                  keys: [{ address: ALICE, weight: 1n }],
                },
              ],
            }),
          ),
          OWNER,
        ),
      /5 keys/,
    );
  });

  it("refuses an out-of-range freeze resource", () => {
    const value = encodeMessage([
      { field: 1, bytes: requiredBytesField(1, tronAddressToBytes(OWNER)) },
      { field: 2, bytes: varintField(2, 1n) },
      { field: 3, bytes: varintField(3, 3n) },
    ]);
    refuse(
      () => decodeTron(request(54, "FreezeBalanceV2Contract", value), OWNER),
      /resource is not BANDWIDTH, ENERGY or TRON_POWER/,
    );
  });

  it("refuses delegating TRON_POWER", () => {
    const value = encodeTronContract({
      type: "DelegateResourceContract",
      owner: OWNER,
      resource: 2,
      balance: 1n,
      receiver: ALICE,
      lock: false,
      lockPeriod: 0n,
    });
    refuse(
      () => decodeTron(request(57, "DelegateResourceContract", value), OWNER),
      /delegated resource/,
    );
  });

  const PERMISSION = {
    type: 0,
    id: 2,
    name: "owner",
    threshold: 1n,
    parentId: 0,
    operations: new Uint8Array(0),
    keys: [{ address: ALICE, weight: 1n }],
  };
  const ACTIVE = { ...PERMISSION, type: 2, operations: new Uint8Array(32) };

  const permissionRequest = (
    ownerPermission: typeof PERMISSION,
    actives: ReadonlyArray<typeof ACTIVE>,
    witnessPermission?: typeof PERMISSION,
  ): SignRequest =>
    request(
      46,
      "AccountPermissionUpdateContract",
      valueFor({
        type: "AccountPermissionUpdateContract",
        owner: OWNER,
        ownerPermission,
        ...(witnessPermission === undefined ? {} : { witnessPermission }),
        actives,
      }),
    );

  it("refuses an owner permission of the wrong type", () => {
    refuse(
      () => decodeTron(permissionRequest({ ...PERMISSION, type: 2 }, [ACTIVE]), OWNER),
      /owner permission/,
    );
  });

  it("refuses a witness permission of the wrong type", () => {
    refuse(
      () => decodeTron(permissionRequest(PERMISSION, [ACTIVE], { ...PERMISSION, type: 2 }), OWNER),
      /witness permission/,
    );
  });

  it("refuses an active permission of the wrong type", () => {
    refuse(
      () => decodeTron(permissionRequest(PERMISSION, [{ ...ACTIVE, type: 1 }]), OWNER),
      /active permission/,
    );
  });

  it("refuses operations on owner/witness permissions", () => {
    refuse(
      () =>
        decodeTron(
          permissionRequest({ ...PERMISSION, operations: new Uint8Array(32) }, [ACTIVE]),
          OWNER,
        ),
      /operations/,
    );
    refuse(
      () =>
        decodeTron(
          permissionRequest(PERMISSION, [ACTIVE], {
            ...PERMISSION,
            type: 1,
            operations: new Uint8Array(32),
          }),
          OWNER,
        ),
      /operations/,
    );
  });

  it("refuses an active operations bitmap that is not 32 bytes", () => {
    refuse(
      () =>
        decodeTron(
          permissionRequest(PERMISSION, [{ ...ACTIVE, operations: new Uint8Array(31) }]),
          OWNER,
        ),
      /operations/,
    );
  });

  it("refuses expiration beyond the safe-integer range", () => {
    const req: SignRequest = {
      kind: "tron.transaction",
      network: "tron:728126428",
      account: ACCOUNT,
      rawData: encodeMessage([
        { field: 1, bytes: requiredBytesField(1, raw.refBlockBytes) },
        { field: 4, bytes: requiredBytesField(4, raw.refBlockHash) },
        { field: 8, bytes: varintField(8, 9007199254740993n) },
        {
          field: 11,
          bytes: requiredBytesField(11, contractSlot(1, "TransferContract", raw.contract.value)),
        },
        { field: 14, bytes: varintField(14, TS) },
      ]),
    };
    refuse(() => decodeTron(req, OWNER), /expiration/);
  });
});

describe("blind causes", () => {
  const blind = (name: string, bytes: Uint8Array, reason: string): void => {
    it(name, () => {
      const i = decodeTron(
        { kind: "tron.transaction", network: "tron:728126428", account: ACCOUNT, rawData: bytes },
        OWNER,
      );
      expect(i.blind).toBe(reason);
    });
  };

  blind("unknown raw field 19", extraField(19, requiredBytesField(19, of(1))), "tron-field");
  blind("ref_block_num", extraField(3, requiredVarintField(3, 5)), "tron-field");
  blind("auths", extraField(9, requiredBytesField(9, of(1, 2))), "tron-field");
  blind("scripts", extraField(12, requiredBytesField(12, of(9))), "tron-field");
  blind("Contract.provider", contractExtra(3, requiredBytesField(3, of(7))), "tron-field");
  blind("ContractName", contractExtra(4, requiredBytesField(4, of(8))), "tron-field");

  blind(
    "an unknown field inside the contract value",
    transferValue((v) => {
      const out = new Uint8Array(v.length + 3);
      out.set(v);
      out.set(of(0xa0, 0x01, 0x07), v.length); // field 20, varint 7
      return out;
    }),
    "tron-field",
  );

  blind(
    "vote support = true",
    rawFor(
      contractSlot(
        4,
        "VoteWitnessContract",
        encodeTronContract({
          type: "VoteWitnessContract",
          owner: OWNER,
          votes: [{ witness: ALICE, count: 1n }],
          support: true,
        }),
      ),
    ),
    "tron-field",
  );

  blind(
    "unsupported contract type",
    rawFor(contractSlot(6, "AssetIssueContract", of(0x08, 0x01))),
    "tron-contract",
  );

  blind(
    "unknown enum value 99",
    rawFor(contractSlot(99, "FooContract", of(0x08, 0x01))),
    "tron-contract",
  );

  it("permission update keeps the full content while blind", () => {
    const i = intent("account-permission-update");
    expect(i.blind).toBe("tron-permission-update");
    expect(i.tron?.permissionUpdate?.actives[0]?.keys.map((k) => k.address)).toStrictEqual([
      OWNER,
      ALICE,
    ]);
  });
});

describe("memo and permissionId display", () => {
  it("non-readable memo shows as bytes hex", () => {
    const bytes = encodeTronRawData({ ...raw, memo: of(0xff, 0x00, 0xfe) });
    const i = decodeTron(
      { kind: "tron.transaction", network: "tron:728126428", account: ACCOUNT, rawData: bytes },
      OWNER,
    );
    expect(i.tron?.memo).toStrictEqual({ kind: "bytes", hex: "0xff00fe" });
  });
});

describe("tron.message", () => {
  const messageRequest = (message: Uint8Array): SignRequest => ({
    kind: "tron.message",
    network: "tron:728126428",
    account: ACCOUNT,
    message,
  });

  it("readable text decodes as text", () => {
    const i = decodeTron(messageRequest(new TextEncoder().encode("hello tron")), OWNER);
    expect(i.summary).toBe("message");
    expect(i.message).toStrictEqual({ kind: "text", text: "hello tron" });
    expect(i.blind).toBeUndefined();
    expect(i.family).toBe("tron");
  });

  it("a 32-byte message is message-bytes", () => {
    const i = decodeTron(messageRequest(new Uint8Array(32).fill(0x61)), OWNER);
    expect(i.message?.kind).toBe("bytes");
    expect(i.blind).toBe("message-bytes");
  });

  it("SIWE-shaped text is a malformed sign-in", () => {
    const siwe =
      "example.com wants you to sign in with your Ethereum account:\n" +
      "0x1111111111111111111111111111111111111111\n\nURI: https://example.com";
    const i = decodeTron(messageRequest(new TextEncoder().encode(siwe)), OWNER);
    expect(i.message?.kind).toBe("text");
    expect(i.message).toMatchObject({ kind: "text", signIn: { status: "malformed" } });
  });

  it("non-readable bytes decode as bytes", () => {
    const i = decodeTron(messageRequest(of(0xff, 0xfe, 0x01, 0x02)), OWNER);
    expect(i.message?.kind).toBe("bytes");
    expect(i.blind).toBe("message-bytes");
  });
});

describe("normalizeTron", () => {
  const norm = (v: unknown): SignRequest => normalizeTron(v);

  it("accepts a valid transaction request", () => {
    const request = {
      kind: "tron.transaction",
      network: "tron:728126428",
      account: ACCOUNT,
      rawData: hex(vector("trx-transfer").rawDataHex),
    };
    expect(norm(request)).toStrictEqual(request);
  });

  it("refuses a bare 32-byte digest", () => {
    expect(() =>
      norm({
        kind: "tron.transaction",
        network: "tron:728126428",
        account: ACCOUNT,
        rawData: new Uint8Array(32),
      }),
    ).toThrow(/32-byte/);
  });

  it("refuses a transaction-shaped message", () => {
    expect(() =>
      norm({
        kind: "tron.message",
        network: "tron:728126428",
        account: ACCOUNT,
        message: hex(vector("trx-transfer").rawDataHex),
      }),
    ).toThrow(/could be a transaction/);
  });

  it("refuses a Transaction-envelope message", () => {
    const envelope = encodeMessage([
      { field: 1, bytes: requiredBytesField(1, hex(vector("trx-transfer").rawDataHex)) },
      { field: 2, bytes: requiredBytesField(2, new Uint8Array(65)) },
    ]);
    expect(() =>
      norm({
        kind: "tron.message",
        network: "tron:728126428",
        account: ACCOUNT,
        message: envelope,
      }),
    ).toThrow(/could be a transaction/);
  });

  it("refuses an unknown network and the hex CAIP-2 alias", () => {
    for (const network of ["tron:0x2b6653dc", "eip155:1", "tron:1"]) {
      expect(() =>
        norm({
          kind: "tron.transaction",
          network,
          account: ACCOUNT,
          rawData: hex(vector("trx-transfer").rawDataHex),
        }),
      ).toThrow(ChainError);
    }
  });

  it("refuses empty messages and non-bytes payloads", () => {
    expect(() =>
      norm({
        kind: "tron.message",
        network: "tron:728126428",
        account: ACCOUNT,
        message: new Uint8Array(0),
      }),
    ).toThrow(ChainError);
    expect(() =>
      norm({ kind: "tron.message", network: "tron:728126428", account: ACCOUNT, message: "hi" }),
    ).toThrow(ChainError);
  });

  it("rejects other kinds as unsupported", () => {
    expect(() =>
      norm({
        kind: "evm.transaction",
        network: "tron:728126428",
        account: ACCOUNT,
        tx: {},
      }),
    ).toThrow(ChainError);
  });
});
