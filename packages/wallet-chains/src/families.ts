/**
 * The protocol families the wallet decodes, and the request surfaces that claim to be one of them.
 * A request a family claims but the decoder did not decode is blind with the row's `nearMiss` — a
 * near miss must not be downgraded to a generic field dump or an opaque call.
 *
 * Deliberately NOT in the table: the protocol routers the owner calls by name (0x Settler, Across,
 * Lido, Jupiter, Metaplex Core), ComputeBudget, and every other contract or program — undecoded
 * calls into them stay opaque-described, naming the contract or program, the same as any contract
 * the owner chooses to trust.
 *
 * Data only: type-level imports, so the EVM bundle never pulls Solana code and vice versa
 * (scripts/size-check.ts budgets per family).
 */
import type { BlindReason } from "./index.ts";
import type { PROGRAM_IDS } from "./solana/ids.ts";

export type FamilyClaim =
  | { readonly surface: "evm.call"; readonly callee: "token-table" | "fiat24" }
  | { readonly surface: "tron.call"; readonly callee: "token-table" }
  | { readonly surface: "evm.typed-data"; readonly primaryType: RegExp }
  | {
      readonly surface: "evm.typed-data";
      readonly domainName: string;
      readonly primaryType?: RegExp;
    }
  | {
      readonly surface: "evm.typed-data";
      readonly verifyingContract: "token-table" | "permit2" | "seaport" | "morpho-blue";
    }
  /* An order protocol's domain name or any of its verifying contracts (either claims it). */
  | {
      readonly surface: "evm.typed-data";
      readonly domainName: string;
      readonly contracts: ReadonlyArray<string>;
    }
  | { readonly surface: "tron.typed-data"; readonly primaryType: RegExp }
  | {
      readonly surface: "tron.typed-data";
      readonly verifyingContract: "token-table" | "permit2";
    }
  | { readonly surface: "solana.instruction"; readonly program: keyof typeof PROGRAM_IDS };

export type RecognisedFamily = {
  readonly family: string;
  readonly claim: FamilyClaim;
  readonly nearMiss: BlindReason;
};

export const RECOGNISED_FAMILIES: ReadonlyArray<RecognisedFamily> = [
  /* The phantom agent's connectionId is a hash of the msgpack action, a commitment no prompt can
     bound; main and imported accounts never get it described (the kernel's agent key signs L1
     actions through its own command). First: an `Exchange`/`Agent` document must not fall through
     to a wider claim. */
  {
    family: "Hyperliquid L1",
    claim: { surface: "evm.typed-data", domainName: "Exchange", primaryType: /^Agent$/ },
    nearMiss: "typed-data-commitment",
  },
  /* Hyperliquid user-signed actions under the HyperliquidSignTransaction domain. */
  {
    family: "Hyperliquid",
    claim: { surface: "evm.typed-data", domainName: "HyperliquidSignTransaction" },
    nearMiss: "typed-data-variant",
  },
  /* Polymarket CLOB orders under the shared exchange domain (docs resources/contracts.md). */
  {
    family: "Polymarket exchange",
    claim: { surface: "evm.typed-data", domainName: "Polymarket CTF Exchange" },
    nearMiss: "typed-data-variant",
  },
  /* Polymarket CLOB L1 auth that derives API credentials (clob-client-v2 signing/eip712.ts). */
  {
    family: "Polymarket CLOB auth",
    claim: { surface: "evm.typed-data", domainName: "ClobAuthDomain" },
    nearMiss: "typed-data-variant",
  },
  /* Polymarket deposit-wallet envelopes: ERC-7739 order wrappers and call batches (docs
     trading/wallets-auth.md). */
  {
    family: "Polymarket deposit wallet",
    claim: { surface: "evm.typed-data", domainName: "DepositWallet" },
    nearMiss: "typed-data-variant",
  },
  /* An undecoded call into a pinned Fiat24 contract, or a Fiat24-specific selector sent
     anywhere else — the claim covers wrong chains, implementations and lookalikes (the ten
     selectors are collision-free in the 4byte signature database). */
  {
    family: "Fiat24",
    claim: { surface: "evm.call", callee: "fiat24" },
    nearMiss: "fiat24-function",
  },
  /* ERC-20/721/1155 transfer, approve and setApprovalForAll selectors to a listed token. */
  {
    family: "built-in token",
    claim: { surface: "evm.call", callee: "token-table" },
    nearMiss: "token-function",
  },
  /* The same selectors in a TriggerSmartContract to a listed TRC-20 token. */
  {
    family: "built-in TRON token",
    claim: { surface: "tron.call", callee: "token-table" },
    nearMiss: "token-function",
  },
  /* EIP-2612 and DAI Permit on any contract, and the Permit2 forms when addressed to Permit2. */
  {
    family: "permit",
    claim: { surface: "evm.typed-data", primaryType: /^Permit/ },
    nearMiss: "typed-data-variant",
  },
  /* PermitSingle/PermitBatch and Permit[Batch][Witness]TransferFrom orders addressed to Permit2. */
  {
    family: "Permit2",
    claim: { surface: "evm.typed-data", verifyingContract: "permit2" },
    nearMiss: "typed-data-variant",
  },
  /* EIP-2612 and DAI Permits signed to a token in the built-in table. */
  {
    family: "built-in token signature",
    claim: { surface: "evm.typed-data", verifyingContract: "token-table" },
    nearMiss: "typed-data-variant",
  },
  /* SafeTx with calls decoded under the transaction rules and the multisend/refund checks. */
  {
    family: "Safe",
    claim: { surface: "evm.typed-data", primaryType: /^SafeTx$/ },
    nearMiss: "typed-data-variant",
  },
  /* OrderComponents orders; BulkOrder and any other shape on this primary type is a near miss. */
  {
    family: "Seaport",
    claim: { surface: "evm.typed-data", primaryType: /^(?:OrderComponents|BulkOrder)$/ },
    nearMiss: "typed-data-variant",
  },
  /* The same orders — this row catches Seaport-addressed documents under other primary types. */
  {
    family: "Seaport",
    claim: { surface: "evm.typed-data", verifyingContract: "seaport" },
    nearMiss: "typed-data-variant",
  },
  /* 1inch Limit Order Protocol orders at the Aggregation Router v6 (verified eip712Domain per
     chain in vectors/chains/order-protocols.json) or the v5 router (code only — claim-only). */
  {
    family: "1inch",
    claim: {
      surface: "evm.typed-data",
      domainName: "1inch Aggregation Router",
      contracts: [
        "0x111111125421cA6dc452d289314280a0f8842A65",
        "0x6fd4383cB451173D5f9304F041C7BCBf27d561fF",
        "0x1111111254EEB25477B68fb85Ed929f73A960582",
      ],
    },
    nearMiss: "typed-data-variant",
  },
  /* Standalone 1inch LOP v2 deployments, DOMAIN_SEPARATOR probed in
     vectors/chains/order-protocols.json; addresses from the erc7730 registry at 3d332d5f
     (https://github.com/LedgerHQ/clear-signing-erc7730-registry/blob/3d332d5fb832b78e4745ee6c7046a0c2ea100426/registry/1inch/eip712-1inch-limit-order.json). */
  {
    family: "1inch LOP",
    claim: {
      surface: "evm.typed-data",
      domainName: "1inch Limit Order Protocol",
      contracts: [
        "0x119c71D3BbAC22029622cbaEc24854d3D32D2828",
        "0x11431a89893025D2a48dCA4EddC396f8C8117187",
        "0x1e38Eff998DF9d3669E32f4ff400031385Bf6362",
        "0x94Bc2a1C732BcAd7343B25af48385Fe76E08734f",
        "0x7F069df72b7A39bCE9806e3AfaF579E54D8CF2b9",
      ],
    },
    nearMiss: "typed-data-variant",
  },
  /* CoW GPv2 orders on the settlement contract (networks.json in cowprotocol/contracts at
     ea0c36591b6da73b9ba4e2e2107897080c7f9b68; probed in vectors/chains/order-protocols.json). */
  {
    family: "CoW",
    claim: {
      surface: "evm.typed-data",
      domainName: "Gnosis Protocol",
      contracts: ["0x9008D19f58AAbD9eD0D60971565AA8510560ab41"],
    },
    nearMiss: "typed-data-variant",
  },
  /* Snapshot `Vote` documents and `Alias` authorizations under the snapshot 0.1.4 domain
     (snapshot.js src/sign/{index,types}.ts). */
  {
    family: "Snapshot",
    claim: {
      surface: "evm.typed-data",
      domainName: "snapshot",
      primaryType: /^(?:Vote|Alias)$/,
    },
    nearMiss: "typed-data-variant",
  },
  /* 0x v4 Exchange Proxy limit/RFQ/OTC orders (FixinEIP712.sol domain "ZeroEx"/1.0.0; probed
     in vectors/chains/order-protocols.json). */
  {
    family: "0x",
    claim: {
      surface: "evm.typed-data",
      domainName: "ZeroEx",
      contracts: [
        "0xDef1C0ded9bec7F1a1670819833240f027b25EfF",
        "0xDEF1ABE32c034e558Cdd535791643C58a13aCC10",
      ],
    },
    nearMiss: "typed-data-variant",
  },
  /* Blur: v1 Blur Exchange (on-chain NAME()/VERSION(); code-423n4/2022-10-blur
     BlurExchange.sol:57-58), Marketplace 3 and Blend claimed by address only (Etherscan tags). */
  {
    family: "Blur",
    claim: {
      surface: "evm.typed-data",
      domainName: "Blur Exchange",
      contracts: [
        "0x000000000000Ad05Ccc4F10045630fb830B95127",
        "0xb2ecfE4E4D61f8790bbb9DE2D1259B9e2410CEA5",
        "0x29469395eAf6f95920E59F858042f0e28D98a20B",
      ],
    },
    nearMiss: "typed-data-variant",
  },
  /* LooksRare v2 (on-chain DOMAIN_SEPARATOR match — vectors/chains/order-protocols.json). */
  {
    family: "LooksRare",
    claim: {
      surface: "evm.typed-data",
      domainName: "LooksRareProtocol",
      contracts: ["0x0000000000E655fAe4d56241588680F86E3b2377"],
    },
    nearMiss: "typed-data-variant",
  },
  /* Bebop RFQ and Bebop JAM (deployments and domains probed on-chain in
     vectors/chains/order-protocols.json). */
  {
    family: "Bebop",
    claim: {
      surface: "evm.typed-data",
      domainName: "BebopSettlement",
      contracts: ["0xbbbbbBB520d69a9775E85b458C58c648259FAD5F"],
    },
    nearMiss: "typed-data-variant",
  },
  {
    family: "Bebop",
    claim: {
      surface: "evm.typed-data",
      domainName: "JamSettlement",
      contracts: ["0xbEbEbEb035351f58602E0C1C8B59ECBfF5d5f47b"],
    },
    nearMiss: "typed-data-variant",
  },
  /* Paraswap Augustus RFQ (erc7730 registry at 3d332d5f
     https://github.com/LedgerHQ/clear-signing-erc7730-registry/blob/3d332d5fb832b78e4745ee6c7046a0c2ea100426/registry/paraswap/eip712-paraswap.json;
     code present — vectors/chains/order-protocols.json). */
  {
    family: "Paraswap",
    claim: {
      surface: "evm.typed-data",
      domainName: "AUGUSTUS RFQ",
      contracts: [
        "0xe92b586627ccA7a83dC919cc7127196d70f55a06",
        "0x0927FD43a7a87E3E8b81Df2c44B03C4756849F6D",
        "0x8DcDfe88EF0351f27437284D0710cD65b20288bb",
        "0xF3CD476C3C4D3Ac5cA2724767f269070CA09A043",
      ],
    },
    nearMiss: "typed-data-variant",
  },
  /* Velora Delta v2 (on-chain match; erc7730 registry/paraswap/eip712-Velora-DeltaV2.json). */
  {
    family: "Velora Delta",
    claim: {
      surface: "evm.typed-data",
      domainName: "Portikus",
      contracts: ["0x0000000000bbF5c5Fd284e657F01Bd000933C96D"],
    },
    nearMiss: "typed-data-variant",
  },
  /* KyberSwap limit orders (on-chain separators — vectors/chains/order-protocols.json). */
  {
    family: "KyberSwap",
    claim: {
      surface: "evm.typed-data",
      domainName: "Kyber Limit Order Protocol",
      contracts: ["0x227B0c196eA8db17A665EA6824D972A64202E936"],
    },
    nearMiss: "typed-data-variant",
  },
  {
    family: "KyberSwap",
    claim: {
      surface: "evm.typed-data",
      domainName: "Kyber DSLO Protocol",
      contracts: ["0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C"],
    },
    nearMiss: "typed-data-variant",
  },
  /* OpenOcean limit order v2 (contracts/LimitOrderProtocol.sol in
     openocean-finance/limit-order-protocol-v2 at 747ed8ea309ace67ceaa1b3d1a1a03b8331a1719 —
     https://github.com/openocean-finance/limit-order-protocol-v2/blob/747ed8ea309ace67ceaa1b3d1a1a03b8331a1719/contracts/LimitOrderProtocol.sol;
     probed in vectors/chains/order-protocols.json; the HyperEVM README address has no code and is
     not claimed). */
  {
    family: "OpenOcean",
    claim: {
      surface: "evm.typed-data",
      domainName: "openocean Limit Order Protocol",
      contracts: [
        "0xcC8d695603ce0b43D352891892FcC716c6a7C9f4",
        "0xc0A62DDCd284020dC883C642A3Ed5D2A1770eb91",
        "0xA8A0213bb2ce671E457Ec14D08EB9d40E6DA8e2d",
        "0xFA9B584Bc9543B66BeFdc41fb1DA8636edD7a697",
        "0xB45373129B4220160b92bd2320869f44d48eCd01",
        "0x6a9115a77598cb9897347a6c31E6a164Ea06F870",
        "0xfE9a934A8607EF020aDf22D4431d6cE6005Aa4d3",
        "0xb5486f71C902fe0844Bb07221Fa8f47834d90B1b",
        "0x23C78B3d85b45BfA6DC8e09b517ba2d9b0ECCA8C",
        "0x99b3488Ee3432bB60256140b4BD2488E3b6A705f",
        "0x4045734fe21c7B7E0cE516BE009780Cc2BA39A8f",
        "0x8D2B7e5501Eb6D92F8e349f2FEbe785DD070bE74",
      ],
    },
    nearMiss: "typed-data-variant",
  },
  /* Odos limit order v2 routers (on-chain eip712Domain — vectors/chains/order-protocols.json;
     github.com/odos-xyz/odos-limit-orders README). */
  {
    family: "Odos",
    claim: {
      surface: "evm.typed-data",
      domainName: "OdosLimitOrderRouter",
      contracts: [
        "0x5F79636fa7bc622eA48802E6cf80A5dae814daE1",
        "0xcbF3822A63B7867cD602317fB4aE3ca864826ef8",
        "0x0D4aB12E62D17f037D43F018Da18FF623e1AF3B2",
        "0x93052961c75c92Fd5d6362655936C239EF2D5336",
        "0xB9CBD870916e9Ffc52076Caa714f85a022B7f330",
        "0x74ab8c1247aE3C5FFFD9F85781F31751bdd98E73",
        "0xa05A88037402d869b7CA69F5bEc098E19BeDaFbB",
        "0xeDeAfdEf0901eF74Ee28c207BE8424D3B353D97A",
        "0x7432657cDda02226ac2aAc9d8f552Ee9613B064e",
        "0xcc0126349d1bD892D1C53381E68dBF0c8F0E045e",
        "0xb3a9B56056a5c93F468dF62579b9A5BEa1741069",
      ],
    },
    nearMiss: "typed-data-variant",
  },
  /* FiatToken EIP-3009 authorizations (circlefin/stablecoin-evm EIP3009.sol TYPEHASHes) —
     decoded under the exact-shape + signer-binding rules; a claimed variant is a near miss. */
  {
    family: "EIP-3009",
    claim: {
      surface: "evm.typed-data",
      primaryType: /^(?:TransferWithAuthorization|ReceiveWithAuthorization|CancelAuthorization)$/,
    },
    nearMiss: "typed-data-variant",
  },
  /* Morpho Blue Authorization documents carry no domain name — a document to a Morpho Blue
     deployment (evm/authority.ts, probed in vectors/chains/account-authority.json) under any
     primary type claims the family. */
  {
    family: "Morpho Blue",
    claim: { surface: "evm.typed-data", verifyingContract: "morpho-blue" },
    nearMiss: "typed-data-variant",
  },
  /* Aave v3 credit delegation (DebtTokenBase.sol DELEGATION_WITH_SIG_TYPEHASH). */
  {
    family: "Aave credit delegation",
    claim: { surface: "evm.typed-data", primaryType: /^DelegationWithSig$/ },
    nearMiss: "typed-data-variant",
  },
  /* Farcaster signer-key documents (farcasterxyz/contracts@9894509 src/KeyGateway.sol and
     src/validators/SignedKeyRequestValidator.sol) — the only deployments, probed in
     vectors/chains/account-authority.json. */
  {
    family: "Farcaster KeyGateway",
    claim: {
      surface: "evm.typed-data",
      domainName: "Farcaster KeyGateway",
      contracts: ["0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B"],
    },
    nearMiss: "typed-data-variant",
  },
  {
    family: "Farcaster SignedKeyRequestValidator",
    claim: {
      surface: "evm.typed-data",
      domainName: "Farcaster SignedKeyRequestValidator",
      contracts: ["0x00000000FC700472606ED4fA22623Acf62c60553"],
    },
    nearMiss: "typed-data-variant",
  },
  /* The TIP-712 permits the TRON decoder recognises: EIP-2612 and DAI Permit on any contract, and
     the Permit2 forms when addressed to the TRON Permit2 deployment. */
  {
    family: "TRON permit",
    claim: { surface: "tron.typed-data", primaryType: /^Permit/ },
    nearMiss: "typed-data-variant",
  },
  {
    family: "TRON Permit2",
    claim: { surface: "tron.typed-data", verifyingContract: "permit2" },
    nearMiss: "typed-data-variant",
  },
  {
    family: "built-in TRC-20 signature",
    claim: { surface: "tron.typed-data", verifyingContract: "token-table" },
    nearMiss: "typed-data-variant",
  },
  /* Transfer, CreateAccount, CreateAccountWithSeed and AdvanceNonceAccount of the System program. */
  {
    family: "System",
    claim: { surface: "solana.instruction", program: "system" },
    nearMiss: "core-instruction",
  },
  /* TransferChecked, Approve, SyncNative, self-close, InitializeAccount and Revoke. */
  {
    family: "Token",
    claim: { surface: "solana.instruction", program: "token" },
    nearMiss: "core-instruction",
  },
  /* The same instructions as Token — both programs share one decoder. */
  {
    family: "Token-2022",
    claim: { surface: "solana.instruction", program: "token2022" },
    nearMiss: "core-instruction",
  },
  /* Initialize(Checked), Authorize(Checked), DelegateStake, Withdraw and Deactivate. */
  {
    family: "Stake",
    claim: { surface: "solana.instruction", program: "stake" },
    nearMiss: "core-instruction",
  },
  /* Create/CreateIdempotent of the Associated Token program. */
  {
    family: "Associated Token",
    claim: { surface: "solana.instruction", program: "associatedToken" },
    nearMiss: "core-instruction",
  },
];
