/**
 * TRON_CONTRACT_TYPES equals Tron.proto's Transaction.Contract.ContractType enum — all 40 values
 * embedded literally from
 * https://github.com/tronprotocol/protocol/blob/8432beca98c52ba04c82aea0b48ae9f9f882c82a/core/Tron.proto#L337-L379
 * — with the treatment each deserves.
 */
// oxlint-disable vitest/no-conditional-in-test -- the treatment table is computed from the two sets
import { describe, expect, it } from "vite-plus/test";

import { TRON_CONTRACT_TYPES, tronContractType, tronTypeUrl } from "../src/tron/contract-types.ts";

const ENUM: ReadonlyArray<readonly [number, string]> = [
  [0, "AccountCreateContract"],
  [1, "TransferContract"],
  [2, "TransferAssetContract"],
  [3, "VoteAssetContract"],
  [4, "VoteWitnessContract"],
  [5, "WitnessCreateContract"],
  [6, "AssetIssueContract"],
  [8, "WitnessUpdateContract"],
  [9, "ParticipateAssetIssueContract"],
  [10, "AccountUpdateContract"],
  [11, "FreezeBalanceContract"],
  [12, "UnfreezeBalanceContract"],
  [13, "WithdrawBalanceContract"],
  [14, "UnfreezeAssetContract"],
  [15, "UpdateAssetContract"],
  [16, "ProposalCreateContract"],
  [17, "ProposalApproveContract"],
  [18, "ProposalDeleteContract"],
  [19, "SetAccountIdContract"],
  [20, "CustomContract"],
  [30, "CreateSmartContract"],
  [31, "TriggerSmartContract"],
  [32, "GetContract"],
  [33, "UpdateSettingContract"],
  [41, "ExchangeCreateContract"],
  [42, "ExchangeInjectContract"],
  [43, "ExchangeWithdrawContract"],
  [44, "ExchangeTransactionContract"],
  [45, "UpdateEnergyLimitContract"],
  [46, "AccountPermissionUpdateContract"],
  [48, "ClearABIContract"],
  [49, "UpdateBrokerageContract"],
  [51, "ShieldedTransferContract"],
  [52, "MarketSellAssetContract"],
  [53, "MarketCancelOrderContract"],
  [54, "FreezeBalanceV2Contract"],
  [55, "UnfreezeBalanceV2Contract"],
  [56, "WithdrawExpireUnfreezeContract"],
  [57, "DelegateResourceContract"],
  [58, "UnDelegateResourceContract"],
  [59, "CancelAllUnfreezeV2Contract"],
];

const DESCRIBED = new Set([1, 2, 4, 13, 31, 54, 55, 56, 57, 58, 59]);

describe("TRON_CONTRACT_TYPES", () => {
  it("equals the full ContractType enum (all 41 values)", () => {
    expect(TRON_CONTRACT_TYPES.map((t) => [t.id, t.name] as const)).toStrictEqual(ENUM);
    expect(TRON_CONTRACT_TYPES).toHaveLength(41);
  });

  it("assigns the right treatment to every entry", () => {
    for (const { id, treatment } of TRON_CONTRACT_TYPES) {
      const expected =
        id === 46 ? "permission-update" : DESCRIBED.has(id) ? "described" : "unsupported";
      expect(treatment, `${id}`).toBe(expected);
    }
  });

  it("tronContractType and tronTypeUrl round-trip", () => {
    expect(tronContractType(31)?.name).toBe("TriggerSmartContract");
    expect(tronContractType(99)).toBeUndefined();
    expect(tronTypeUrl("TransferContract")).toBe("type.googleapis.com/protocol.TransferContract");
  });
});
