import { hexToBytes } from "@noble/hashes/utils.js";
/**
 * A TriggerSmartContract carrying a TRC-10 `call_token_value` on top of a table-verified TRC-20
 * transfer downgrades verifiability to `partial`: the attached TRC-10 leg cannot be verified.
 */
import { describe, expect, it } from "vite-plus/test";

import type { SignRequest } from "../../src/index.ts";
import { tronAddressToBytes } from "../../src/tron/address.ts";
import { encodeTronContract } from "../../src/tron/contracts.ts";
import { decodeTron } from "../../src/tron/decode.ts";
import {
  bytesField,
  encodeMessage,
  requiredBytesField,
  stringField,
  varintField,
} from "../../src/tron/proto.ts";
import { decodeTronRawData } from "../../src/tron/raw.ts";
import { ACCOUNT, OWNER, tronVectors } from "../tron.ts";

const ALICE = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRC10_ID = 1002000n;

const vector = tronVectors.transactions.find((t) => t.name === "trx-transfer");
if (vector === undefined) {
  throw new Error("missing trx-transfer vector");
}
const raw = decodeTronRawData(hexToBytes(vector.rawDataHex));

const word = (bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
};

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

const request = (value: Uint8Array): SignRequest => ({
  kind: "tron.transaction",
  network: "tron:728126428",
  account: ACCOUNT,
  rawData: encodeMessage([
    { field: 1, bytes: requiredBytesField(1, raw.refBlockBytes) },
    { field: 4, bytes: requiredBytesField(4, raw.refBlockHash) },
    { field: 8, bytes: varintField(8, raw.expiration) },
    { field: 11, bytes: requiredBytesField(11, contractSlot(31, "TriggerSmartContract", value)) },
    { field: 14, bytes: varintField(14, raw.timestamp ?? 0n) },
    { field: 18, bytes: varintField(18, 1_000_000n) },
  ]),
});

/* transfer(address,uint256) to ALICE for 10 USDT, ABI-encoded with the EVM form of the address. */
const uint256 = (value: bigint): Uint8Array => hexToBytes(value.toString(16).padStart(64, "0"));

const transferData = (to: Uint8Array, amount: bigint): Uint8Array => {
  const data = new Uint8Array(4 + 64);
  data.set(hexToBytes("a9059cbb"));
  data.set(word(to), 4);
  data.set(uint256(amount), 36);
  return data;
};

describe("TRON call_token_value on a verified token call", () => {
  it("a USDT transfer trigger carrying TRC-10 value drops to partial and lists both legs", () => {
    const value = encodeTronContract({
      type: "TriggerSmartContract",
      owner: OWNER,
      contract: USDT,
      callValue: 0n,
      data: transferData(tronAddressToBytes(ALICE).slice(1), 10_000_000n),
      callTokenValue: 500n,
      tokenId: TRC10_ID,
    });
    const intent = decodeTron(request(value), OWNER);
    expect(intent.summary).toBe("transfer");
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows).toStrictEqual([
      { to: USDT, amount: { asset: `trc10:${TRC10_ID}`, amount: "500" }, verified: false },
      {
        to: ALICE,
        amount: { asset: USDT, amount: "10000000", symbol: "USDT", decimals: 6 },
        verified: true,
      },
    ]);
  });
});
