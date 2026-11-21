/**
 * The complete `Transaction.Contract.ContractType` table — all 41 values of the enum, in proto
 * order, from
 * https://github.com/tronprotocol/protocol/blob/8432beca98c52ba04c82aea0b48ae9f9f882c82a/core/Tron.proto#L337-L379
 * A contract type's `name` builds its `Any.type_url` (`type.googleapis.com/protocol.<name>`);
 * `treatment` decides the signing surface: "described" — decoded into a bounded intent;
 * "permission-update" — decoded in full but always blind (it hands account control to other keys);
 * "unsupported" — an opaque blind call.
 */
export type TronContractTreatment = "described" | "permission-update" | "unsupported";

export const TRON_CONTRACT_TYPES: ReadonlyArray<{
  readonly id: number;
  readonly name: string;
  readonly treatment: TronContractTreatment;
}> = [
  { id: 0, name: "AccountCreateContract", treatment: "unsupported" },
  { id: 1, name: "TransferContract", treatment: "described" },
  { id: 2, name: "TransferAssetContract", treatment: "described" },
  { id: 3, name: "VoteAssetContract", treatment: "unsupported" },
  { id: 4, name: "VoteWitnessContract", treatment: "described" },
  { id: 5, name: "WitnessCreateContract", treatment: "unsupported" },
  { id: 6, name: "AssetIssueContract", treatment: "unsupported" },
  { id: 8, name: "WitnessUpdateContract", treatment: "unsupported" },
  { id: 9, name: "ParticipateAssetIssueContract", treatment: "unsupported" },
  { id: 10, name: "AccountUpdateContract", treatment: "unsupported" },
  { id: 11, name: "FreezeBalanceContract", treatment: "unsupported" },
  { id: 12, name: "UnfreezeBalanceContract", treatment: "unsupported" },
  { id: 13, name: "WithdrawBalanceContract", treatment: "described" },
  { id: 14, name: "UnfreezeAssetContract", treatment: "unsupported" },
  { id: 15, name: "UpdateAssetContract", treatment: "unsupported" },
  { id: 16, name: "ProposalCreateContract", treatment: "unsupported" },
  { id: 17, name: "ProposalApproveContract", treatment: "unsupported" },
  { id: 18, name: "ProposalDeleteContract", treatment: "unsupported" },
  { id: 19, name: "SetAccountIdContract", treatment: "unsupported" },
  { id: 20, name: "CustomContract", treatment: "unsupported" },
  { id: 30, name: "CreateSmartContract", treatment: "unsupported" },
  { id: 31, name: "TriggerSmartContract", treatment: "described" },
  { id: 32, name: "GetContract", treatment: "unsupported" },
  { id: 33, name: "UpdateSettingContract", treatment: "unsupported" },
  { id: 41, name: "ExchangeCreateContract", treatment: "unsupported" },
  { id: 42, name: "ExchangeInjectContract", treatment: "unsupported" },
  { id: 43, name: "ExchangeWithdrawContract", treatment: "unsupported" },
  { id: 44, name: "ExchangeTransactionContract", treatment: "unsupported" },
  { id: 45, name: "UpdateEnergyLimitContract", treatment: "unsupported" },
  { id: 46, name: "AccountPermissionUpdateContract", treatment: "permission-update" },
  { id: 48, name: "ClearABIContract", treatment: "unsupported" },
  { id: 49, name: "UpdateBrokerageContract", treatment: "unsupported" },
  { id: 51, name: "ShieldedTransferContract", treatment: "unsupported" },
  { id: 52, name: "MarketSellAssetContract", treatment: "unsupported" },
  { id: 53, name: "MarketCancelOrderContract", treatment: "unsupported" },
  { id: 54, name: "FreezeBalanceV2Contract", treatment: "described" },
  { id: 55, name: "UnfreezeBalanceV2Contract", treatment: "described" },
  { id: 56, name: "WithdrawExpireUnfreezeContract", treatment: "described" },
  { id: 57, name: "DelegateResourceContract", treatment: "described" },
  { id: 58, name: "UnDelegateResourceContract", treatment: "described" },
  { id: 59, name: "CancelAllUnfreezeV2Contract", treatment: "described" },
];

export const tronContractType = (
  id: number,
):
  | { readonly id: number; readonly name: string; readonly treatment: TronContractTreatment }
  | undefined => TRON_CONTRACT_TYPES.find((t) => t.id === id);

/** `Any.type_url` for a contract type name — the only form the chain emits. */
export const tronTypeUrl = (name: string): string => `type.googleapis.com/protocol.${name}`;
