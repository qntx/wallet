/**
 * The bitcoin helpers the driver stages share: the InputScriptType each account template asks the
 * device for, the coin name the wire messages carry, and the wire sign list of a bitcoin.psbt
 * stage. `verifyAddress`, `displayFor` and `sign` all adapt through these so the template→enum and
 * network→coin-name mappings exist exactly once.
 */
import { bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";
import type { ChainSignRequest } from "@qntx/wallet/protocol";

import type { ChainPlan } from "../../chains/run.ts";
import { integrity } from "./errors.ts";
import type { BitcoinSignEntry } from "./protocol/index.ts";

/**
 * InputScriptType (messages-bitcoin.proto) per account template: the device derives each
 * input/change/address script from this hint plus the path. `btc.bip49` is SPENDP2SHWITNESS (4) —
 * the enum order is not the BIP order.
 */
export const SPENDADDRESS = 0;
export const SPENDP2SHWITNESS = 4;
export const SPENDWITNESS = 3;
export const SPENDTAPROOT = 5;

export const SCRIPT_TYPE: Readonly<Record<string, number>> = {
  "btc.bip44": SPENDADDRESS,
  "btc.bip49": SPENDP2SHWITNESS,
  "btc.bip84": SPENDWITNESS,
  "btc.bip86": SPENDTAPROOT,
};

/** `mainnet` | `testnet` — the only coin names the wire messages know. */
export const btcCoinName = (network: string): "mainnet" | "testnet" =>
  bitcoinNetwork(network).coinType === 0 ? "mainnet" : "testnet";

/**
 * The wire sign list of a bitcoin.psbt stage: `inputs`/`tasks` are aligned by the planner, so entry
 * i takes the PSBT index of input i, the path of task i and the template of the request's `sign`
 * row for that index. A plan whose rows do not line up is `integrity` — the signer must never sign
 * under a different key than the plan claimed.
 */
export const psbtEntries = (
  request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }>,
  stage: Extract<ChainPlan, { kind: "bitcoin.psbt" }>,
): ReadonlyArray<BitcoinSignEntry> => {
  const scriptType = new Map<number, number>();
  for (const entry of request.sign) {
    const type = SCRIPT_TYPE[entry.template];
    if (type === undefined) {
      integrity(`unknown bitcoin template ${entry.template}`);
    }
    scriptType.set(entry.index, type);
  }
  return stage.inputs.map((input, i) => {
    const type = scriptType.get(input.index);
    const task = stage.tasks[i];
    if (type === undefined || task === undefined) {
      integrity("the plan's inputs and tasks disagree");
    }
    return { index: input.index, path: task.path, scriptType: type };
  });
};
