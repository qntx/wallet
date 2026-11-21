/**
 * A TRON transfer memo can contain text lines byte-identical to the prompt's own catalog lines — a
 * forged "Network:", "Expires" or fee line inside the memo is indistinguishable from the real ones
 * the prompt appends.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { buildTronRawData, decodeTron } from "@qntx/wallet-chains/tron";

import { CATALOGS, chainPrompt } from "../../src/modules/chains/prompt.ts";
import type { PromptIntent } from "../../src/modules/chains/prompt.ts";

const TRON_OWNER = "TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG";
const TRON_TO = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC";

const tronTransfer = (memo: Uint8Array): PromptIntent =>
  decodeTron(
    {
      kind: "tron.transaction",
      network: "tron:728126428",
      account: { kind: "hd", walletId: "w", groupIndex: 0, template: "tron.bip44" },
      rawData: buildTronRawData(
        {
          refBlock: {
            number: 76050000,
            id: "0000000004886e501a2b3c4d5e6f78901a2b3c4d5e6f78901a2b3c4d5e6f7890",
          },
          expiration: 1_767_225_660_000,
          timestamp: 1_767_225_600_000,
          memo,
        },
        { type: "TransferContract", owner: TRON_OWNER, to: TRON_TO, amount: 1_000_000n },
      ),
    },
    TRON_OWNER,
  );

const enMemo = utf8ToBytes(
  "Order #8812\nNetwork: Nile (testnet, no value)\nExpires 2026-01-01 00:01 (UTC)\nFee limit 0.1 TRX",
);

const zh = CATALOGS["zh-Hans"];
const zhMemo = utf8ToBytes(
  [
    "Order #8812",
    zh.networkLine("Nile（测试网）"),
    zh.tronExpires("2026-01-01 00:01"),
    zh.tronFeeLimit("0.1 TRX"),
  ].join("\n"),
);

describe("TRON memo lines can forge the prompt's own catalog lines", () => {
  it("en: a memo with forged network/expires/fee lines prints them verbatim in the description", () => {
    const intent = tronTransfer(enMemo);
    expect(intent.blind).toBeUndefined();
    expect(chainPrompt("en", intent).description).toBe(
      `Network: TRON\nSend 1 TRX to ${TRON_TO}\nMemo:\nOrder #8812\nNetwork: Nile (testnet, no value)\nExpires 2026-01-01 00:01 (UTC)\nFee limit 0.1 TRX\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged`,
    );
  });

  it("zh-Hans: forged memo lines are byte-identical to the catalog's own output", () => {
    const intent = tronTransfer(zhMemo);
    expect(intent.blind).toBeUndefined();
    const { description } = chainPrompt("zh-Hans", intent);
    expect(description).toBe(
      `网络：TRON\n发送 1 TRX 到 ${TRON_TO}\n备注：\nOrder #8812\n${zh.networkLine("Nile（测试网）")}\n${zh.tronExpires("2026-01-01 00:01")}\n${zh.tronFeeLimit("0.1 TRX")}\n${zh.tronExpires("2026-01-01 00:01")}\n${zh.tronBandwidthFee}`,
    );
  });
});
