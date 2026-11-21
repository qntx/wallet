/**
 * `decodeTron(request, signer)` — the TRON display decoder of design.md "解码结果". A modeled
 * contract's `owner_address` must be the signing account; a semantic bound the chain would reject
 * (zero amount, 31 votes, 9 actives, …) is refused outright as `invalid-request`; and anything the
 * decoder cannot bound — unsupported or unknown contract types, TaPoS/provider fields, unknown
 * value fields, out-of-range enums — is blind, never silently ignored. Blind precedence:
 * `tron-permission-update` > `tron-contract` > `tron-field` > `token-function`.
 */
import { bytesToHex } from "@noble/hashes/utils.js";

import { hasHiddenCharacters } from "../display.ts";
import { recognizePermit } from "../evm/permit.ts";
import { decodeTokenCall } from "../evm/token-call.ts";
import type { TokenCall } from "../evm/token-call.ts";
import type { EvmTokenTable } from "../evm/tokens.ts";
import { domainChainId, isTypedDataMessage, typedDataFields } from "../evm/typed-data.ts";
import { ChainError, messageBlindReason, messageContent } from "../index.ts";
import type {
  ApprovalChange,
  AssetAmount,
  AssetFlow,
  BlindReason,
  DisplayIntent,
  IntentSummary,
  SignRequest,
  StakeAction,
  TronPermission,
  TronResource,
  TypedDataDomain,
  TypedDataLeaf,
} from "../index.ts";
import { networkMeta } from "../networks.ts";
import { tronAddressFromEvm, tronAddressToEvm } from "./address.ts";
import { TRON_NATIVE_ASSET } from "./assets.ts";
import { tronContractType } from "./contract-types.ts";
import { decodeTronContract } from "./contracts.ts";
import type { TronContract, TronPermissionWire } from "./contracts.ts";
import { tronCallNearMiss, tronTypedDataNearMiss } from "./families.ts";
import { TRON_PERMIT2 } from "./permit2.ts";
import { decodeTronRawData } from "./raw.ts";
import type { TronRawData } from "./raw.ts";
import { lookupTronToken, tronTokenTable } from "./tokens.ts";
import type { TronTokenTable } from "./tokens.ts";
import {
  parseTronTypedData,
  tronTypedDataBase58,
  tronTypedDataLeaf,
  tronTypedDataToEvm,
} from "./typed-data.ts";

const refuse = (what: string): never => {
  throw new ChainError("invalid-request", what);
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** All TRX amounts carry the native asset id, 6 decimals and the network's symbol. */
const sun = (amount: bigint, symbol: string): AssetAmount => ({
  asset: TRON_NATIVE_ASSET,
  amount: amount.toString(10),
  decimals: 6,
  symbol,
});

const trc10 = (assetId: string, amount: bigint): AssetAmount => ({
  asset: `trc10:${assetId}`,
  amount: amount.toString(10),
});

const RESOURCES: ReadonlyArray<TronResource> = ["bandwidth", "energy", "tron-power"];
const selectorOf = (data: Uint8Array): string =>
  data.length === 0 ? "0x" : `0x${bytesToHex(data.subarray(0, Math.min(4, data.length)))}`;

/** The tokenCall's EVM-form addresses mapped back to base58 for display. */
const mapTokenCall = (call: TokenCall): TokenCall => ({
  ...call,
  outflows: call.outflows.map((flow) => ({
    ...flow,
    to: tronAddressFromEvm(flow.to),
    amount: { ...flow.amount, asset: tronAddressFromEvm(flow.amount.asset) },
  })),
  approvals: call.approvals.map((a) =>
    a.kind === "allowance"
      ? {
          ...a,
          spender: tronAddressFromEvm(a.spender),
          amount: { ...a.amount, asset: tronAddressFromEvm(a.amount.asset) },
        }
      : { ...a, asset: tronAddressFromEvm(a.asset), spender: tronAddressFromEvm(a.spender) },
  ),
});

/** An EVM-shaped view of the TRON table for decodeTokenCall: chainId → checksummed 0x → token. */
const evmTableFor = (network: string, chainId: number, table: TronTokenTable): EvmTokenTable => ({
  [String(chainId)]: Object.fromEntries(
    Object.entries(table[network] ?? {}).map(([address, token]) => [
      tronAddressToEvm(address),
      token,
    ]),
  ),
});

const permissionDisplay = (
  type: "owner" | "witness" | "active",
  p: TronPermissionWire,
): TronPermission => ({
  type,
  id: p.id,
  name: p.name,
  threshold: p.threshold.toString(10),
  parentId: p.parentId,
  ...(type === "active" ? { operations: `0x${bytesToHex(p.operations)}` } : {}),
  keys: p.keys.map((k) => ({ address: k.address, weight: k.weight.toString(10) })),
});

const memoDisplay = (
  memo: Uint8Array,
):
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bytes"; readonly hex: string } => {
  try {
    const text = utf8.decode(memo);
    if (!hasHiddenCharacters(text)) {
      return { kind: "text", text };
    }
  } catch {
    // not UTF-8
  }
  return { kind: "bytes", hex: `0x${bytesToHex(memo)}` };
};

type Effects = {
  readonly summary: IntentSummary;
  readonly outflows: ReadonlyArray<AssetFlow>;
  readonly approvals: ReadonlyArray<ApprovalChange>;
  readonly staking?: ReadonlyArray<StakeAction>;
  readonly verifiability: "full" | "partial" | "opaque";
  readonly contract?: DisplayIntent["contract"];
  readonly blind?: BlindReason;
  readonly permissionUpdate?: NonNullable<DisplayIntent["tron"]>["permissionUpdate"];
};

const stakeEffects = (staking: StakeAction): Effects => ({
  summary: "stake",
  outflows: [],
  approvals: [],
  staking: [staking],
  verifiability: "full",
});

const resourceName = (resource: number): TronResource =>
  RESOURCES[resource] ?? refuse("resource is out of range");

/** A modeled value the display cannot bound blinds the request as tron-field. */
const fieldBlind = (contract: TronContract): boolean =>
  contract.type === "VoteWitnessContract" && contract.support;

/** The semantic bounds a node enforces — a request past them is refused, not described. */
const semanticCheck = (contract: TronContract, raw: TronRawData): void => {
  switch (contract.type) {
    case "TransferContract":
    case "TransferAssetContract":
      if (contract.amount === 0n) {
        refuse("transfer amount is zero");
      }
      if (
        contract.type === "TransferAssetContract" &&
        !/^[1-9][0-9]{0,18}$/.test(contract.assetId)
      ) {
        refuse("asset_name is not a TRC-10 asset id");
      }
      break;
    case "FreezeBalanceV2Contract":
    case "UnfreezeBalanceV2Contract":
      if (contract.amount === 0n) {
        refuse("stake amount is zero");
      }
      if (contract.resource > 2) {
        refuse("resource is not BANDWIDTH, ENERGY or TRON_POWER");
      }
      break;
    case "DelegateResourceContract":
    case "UnDelegateResourceContract":
      if (contract.balance === 0n) {
        refuse("delegated balance is zero");
      }
      if (contract.resource > 1) {
        refuse("delegated resource is not BANDWIDTH or ENERGY");
      }
      break;
    case "TriggerSmartContract":
      if (contract.callTokenValue > 0n && contract.tokenId === 0n) {
        refuse("call_token_value without token_id");
      }
      if (raw.feeLimit === undefined || raw.feeLimit <= 0n) {
        refuse("TriggerSmartContract requires a positive fee_limit");
      }
      break;
    case "VoteWitnessContract":
      if (contract.votes.length === 0 || contract.votes.length > 30) {
        refuse("a vote transaction casts 1 to 30 votes");
      }
      if (contract.votes.some((v) => v.count === 0n)) {
        refuse("vote_count is zero");
      }
      break;
    case "AccountPermissionUpdateContract":
      if (contract.actives.length === 0 || contract.actives.length > 8) {
        refuse("a permission update sets 1 to 8 actives");
      }
      if (contract.ownerPermission.type !== 0) {
        refuse("the owner permission is not type 0");
      }
      if (contract.witnessPermission !== undefined && contract.witnessPermission.type !== 1) {
        refuse("the witness permission is not type 1");
      }
      if (contract.actives.some((p) => p.type !== 2)) {
        refuse("an active permission is not type 2");
      }
      if (
        contract.ownerPermission.operations.length > 0 ||
        (contract.witnessPermission !== undefined &&
          contract.witnessPermission.operations.length > 0)
      ) {
        refuse("an owner/witness permission carries operations");
      }
      if (contract.actives.some((p) => p.operations.length !== 32)) {
        refuse("an active permission's operations is not 32 bytes");
      }
      for (const p of [contract.ownerPermission, contract.witnessPermission, ...contract.actives]) {
        if (p !== undefined && p.keys.length > 5) {
          refuse("a permission holds more than 5 keys");
        }
      }
      break;
    default:
      break;
  }
};

// oxlint-disable-next-line typescript/consistent-return -- the switch over TronContract is exhaustive; every case returns
const contractEffects = (
  contract: TronContract,
  network: string,
  symbol: string,
  chainId: number,
  table: TronTokenTable,
): Effects => {
  switch (contract.type) {
    case "TransferContract":
      return {
        summary: "transfer",
        outflows: [{ to: contract.to, amount: sun(contract.amount, symbol), verified: true }],
        approvals: [],
        verifiability: "full",
      };
    case "TransferAssetContract":
      return {
        summary: "transfer",
        outflows: [
          { to: contract.to, amount: trc10(contract.assetId, contract.amount), verified: false },
        ],
        approvals: [],
        verifiability: "partial",
      };
    case "VoteWitnessContract":
      return stakeEffects({
        kind: "tron-vote",
        votes: contract.votes.map((v) => ({ witness: v.witness, count: v.count.toString(10) })),
      });
    case "FreezeBalanceV2Contract":
      return stakeEffects({
        kind: "tron-freeze",
        amount: sun(contract.amount, symbol),
        resource: resourceName(contract.resource),
      });
    case "UnfreezeBalanceV2Contract":
      return stakeEffects({
        kind: "tron-unfreeze",
        amount: sun(contract.amount, symbol),
        resource: resourceName(contract.resource),
      });
    case "DelegateResourceContract":
      return stakeEffects({
        kind: "tron-delegate",
        receiver: contract.receiver,
        amount: sun(contract.balance, symbol),
        resource: resourceName(contract.resource),
        ...(contract.lock ? { lock: { blocks: contract.lockPeriod.toString(10) } } : {}),
      });
    case "UnDelegateResourceContract":
      return stakeEffects({
        kind: "tron-undelegate",
        receiver: contract.receiver,
        amount: sun(contract.balance, symbol),
        resource: resourceName(contract.resource),
      });
    case "WithdrawExpireUnfreezeContract":
      return stakeEffects({ kind: "tron-withdraw-unfrozen" });
    case "CancelAllUnfreezeV2Contract":
      return stakeEffects({ kind: "tron-cancel-unfreeze" });
    case "WithdrawBalanceContract":
      return stakeEffects({ kind: "tron-claim-rewards" });
    case "AccountPermissionUpdateContract": {
      const { ownerPermission, witnessPermission, actives } = contract;
      return {
        summary: "authorization",
        outflows: [],
        approvals: [],
        verifiability: "partial",
        permissionUpdate: {
          owner: permissionDisplay("owner", ownerPermission),
          ...(witnessPermission === undefined
            ? {}
            : { witness: permissionDisplay("witness", witnessPermission) }),
          actives: actives.map((p) => permissionDisplay("active", p)),
        },
      };
    }
    case "TriggerSmartContract": {
      const token = lookupTronToken(table, network, contract.contract);
      const contractField: NonNullable<DisplayIntent["contract"]> = {
        address: contract.contract,
        created: false,
        selector: selectorOf(contract.data),
        ...(token === undefined ? {} : { symbol: token.symbol }),
      };
      const attached: AssetFlow[] = [];
      if (contract.callValue > 0n) {
        attached.push({
          to: contract.contract,
          amount: sun(contract.callValue, symbol),
          verified: true,
        });
      }
      if (contract.callTokenValue > 0n) {
        attached.push({
          to: contract.contract,
          amount: trc10(contract.tokenId.toString(10), contract.callTokenValue),
          verified: false,
        });
      }
      const tokenCall =
        contract.data.length === 0
          ? undefined
          : decodeTokenCall(
              tronAddressToEvm(contract.contract),
              `0x${bytesToHex(contract.data)}`,
              chainId,
              evmTableFor(network, chainId, table),
            );
      if (tokenCall !== undefined) {
        const mapped = mapTokenCall(tokenCall);
        return {
          summary: mapped.summary,
          outflows: [...attached, ...mapped.outflows],
          approvals: mapped.approvals,
          verifiability:
            contract.callTokenValue > 0n && mapped.verifiability === "full"
              ? "partial"
              : mapped.verifiability,
          contract: contractField,
        };
      }
      const nearMiss = tronCallNearMiss(contract.contract, network, table);
      return {
        summary: "contract-call",
        outflows: attached,
        approvals: [],
        verifiability: "opaque",
        contract: contractField,
        ...(nearMiss === undefined ? {} : { blind: nearMiss }),
      };
    }
  }
};

/** A permit approval's EVM-form addresses mapped back to base58 for display. */
const mapPermitApproval = (a: ApprovalChange): ApprovalChange =>
  a.kind === "allowance"
    ? {
        ...a,
        spender: tronAddressFromEvm(a.spender),
        amount: { ...a.amount, asset: tronAddressFromEvm(a.amount.asset) },
      }
    : a;

/** The domain fields as the prompt shows them — `verifyingContract` in base58. */
const tronDomainDisplay = (domain: Readonly<Record<string, unknown>>): TypedDataDomain => {
  const { name, version, salt } = domain;
  const chainId = domainChainId(domain);
  const verifying = tronTypedDataBase58(domain["verifyingContract"]);
  return {
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof version === "string" ? { version } : {}),
    ...(chainId === undefined ? {} : { chainId }),
    ...(verifying === undefined ? {} : { verifyingContract: verifying }),
    ...(typeof salt === "string" ? { salt } : {}),
  };
};

/**
 * The display decode of a `tron.typed-data` request. The permit recognizers run on the document
 * mapped to EVM form — every `address` leaf `0x`-hex — so the EVM selector tables match; a document
 * declaring `trcToken` has no EVM equivalent and can only be field-shown or blind. Approvals and
 * addresses come back out in base58. Blind precedence mirrors the EVM lane: a recognized permit's
 * own reason, then family near-miss, then oversize, then commitment.
 */
const tronTypedDataIntent = (
  typedData: string,
  network: string,
  chainId: number,
  signer: string,
  table: TronTokenTable,
): DisplayIntent => {
  const { json } = parseTronTypedData(typedData);
  const evmJson = tronTypedDataToEvm(json);
  const permit2 = TRON_PERMIT2[network];
  const permit =
    evmJson === undefined
      ? undefined
      : recognizePermit(
          evmJson,
          chainId,
          evmTableFor(network, chainId, table),
          tronAddressToEvm(signer),
          permit2 === undefined ? "" : tronAddressToEvm(permit2),
        );
  const nearMiss = permit === undefined ? tronTypedDataNearMiss(json, network, table) : undefined;
  const shown = permit === undefined ? typedDataFields(json, tronTypedDataLeaf) : undefined;
  let fields: ReadonlyArray<TypedDataLeaf> | undefined;
  if (permit === undefined) {
    fields = shown?.fields;
  } else if (permit.fields !== undefined) {
    /* A recognized permit whose witness subtree was displayable on the EVM-mapped doc gets its
       leaves re-walked on the TRON doc so `address` leaves render base58. */
    const witnessType = json.types[json.primaryType]?.at(-1)?.type;
    const { witness } = json.message;
    const subtree =
      witnessType !== undefined && isTypedDataMessage(witness)
        ? typedDataFields(
            { types: json.types, primaryType: witnessType, domain: {}, message: witness },
            tronTypedDataLeaf,
          )
        : undefined;
    fields = subtree?.fields.map((leaf) => ({ path: `witness.${leaf.path}`, value: leaf.value }));
  }
  const blind: BlindReason | undefined =
    permit?.blind ??
    (permit === undefined
      ? (nearMiss ??
        (shown === undefined
          ? "typed-data-oversize"
          : shown.hasCommitment
            ? "typed-data-commitment"
            : undefined))
      : undefined);
  return {
    family: "tron",
    network,
    summary: permit === undefined ? "message" : "approve",
    outflows: [],
    approvals: (permit?.approvals ?? []).map(mapPermitApproval),
    fee: undefined,
    warnings: permit?.warnings ?? [],
    message: {
      kind: "typed-data",
      primaryType: json.primaryType,
      domain: tronDomainDisplay(json.domain),
      data: json.message,
      ...(fields === undefined ? {} : { fields }),
    },
    verifiability: permit === undefined ? "opaque" : "partial",
    ...(blind === undefined ? {} : { blind }),
  };
};

/**
 * The display decode of a normalized request. `signer` is the base58 address the account signs
 * with; a modeled contract whose owner is anyone else is refused.
 */
export const decodeTron = (
  request: SignRequest,
  signer: string,
  table: TronTokenTable = tronTokenTable,
): DisplayIntent => {
  const meta = networkMeta(request.network);
  if (meta === undefined || meta.family !== "tron") {
    throw new ChainError("invalid-request", `unknown TRON network ${request.network}`);
  }
  const { symbol, chainId } = meta;
  if (request.kind === "tron.message") {
    const content = messageContent(request.message, "tron");
    const blind = messageBlindReason(content);
    return {
      family: "tron",
      network: request.network,
      summary: "message",
      outflows: [],
      approvals: [],
      fee: undefined,
      warnings: [],
      message: content,
      verifiability: "opaque",
      ...(blind === undefined ? {} : { blind }),
    };
  }
  if (request.kind === "tron.typed-data") {
    return tronTypedDataIntent(request.typedData, request.network, chainId, signer, table);
  }
  if (request.kind !== "tron.transaction") {
    throw new ChainError("unsupported", `${request.kind} is not a TRON request`);
  }
  const raw = decodeTronRawData(request.rawData);
  if (raw.expiration > BigInt(Number.MAX_SAFE_INTEGER)) {
    refuse("expiration exceeds the safe integer range");
  }
  const type = tronContractType(raw.contract.typeId);
  const contractType = type?.name ?? `ContractType ${raw.contract.typeId}`;
  const tron: NonNullable<DisplayIntent["tron"]> = {
    contractType,
    expiration: Number(raw.expiration),
    ...(raw.contract.permissionId === 0 ? {} : { permissionId: raw.contract.permissionId }),
    ...(raw.memo === undefined ? {} : { memo: memoDisplay(raw.memo) }),
  };
  const fee =
    raw.feeLimit === undefined || raw.feeLimit === 0n
      ? undefined
      : { max: sun(raw.feeLimit, symbol) };
  const base = {
    family: "tron" as const,
    network: request.network,
    approvals: [] as ReadonlyArray<ApprovalChange>,
    warnings: [] as ReadonlyArray<DisplayIntent["warnings"][number]>,
    fee,
    tron,
  };
  // Non-modeled contract types never bind an owner — the signer is told the type name, nothing more.
  const modeled = decodeTronContract(raw.contract.typeId, raw.contract.value);
  if (modeled === undefined) {
    return {
      ...base,
      summary: "contract-call",
      outflows: [],
      verifiability: "opaque",
      blind: "tron-contract",
    };
  }
  const { contract, extra } = modeled;
  if (contract.owner !== signer) {
    throw new ChainError("invalid-request", "owner_address is not the signing account");
  }
  semanticCheck(contract, raw);
  const blind =
    raw.extra.length > 0 ||
    raw.contract.extra.length > 0 ||
    extra.length > 0 ||
    fieldBlind(contract);
  const effects = contractEffects(contract, request.network, symbol, chainId, table);
  const blindReason: BlindReason | undefined =
    contract.type === "AccountPermissionUpdateContract"
      ? "tron-permission-update"
      : blind
        ? "tron-field"
        : effects.blind;
  return {
    ...base,
    summary: effects.summary,
    outflows: effects.outflows,
    approvals: effects.approvals,
    ...(effects.staking === undefined ? {} : { staking: effects.staking }),
    verifiability: effects.verifiability,
    ...(effects.contract === undefined ? {} : { contract: effects.contract }),
    ...(blindReason === undefined ? {} : { blind: blindReason }),
    tron: {
      ...tron,
      ...(effects.permissionUpdate === undefined
        ? {}
        : { permissionUpdate: effects.permissionUpdate }),
    },
  };
};
