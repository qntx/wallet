import type { AccountAuthority, AssetAmount } from "../index.ts";
/**
 * Recognition of account-authority documents — Morpho Blue `Authorization` and Aave v3
 * `DelegationWithSig` — typed data that hands someone else power over the signer's account.
 *
 * Morpho Blue (morpho-org/morpho-blue@339a885 `src/libraries/ConstantsLib.sol`:
 * `Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256
 * deadline)` under `EIP712Domain(uint256 chainId,address verifyingContract)`): `Morpho.sol`'s
 * `setAuthorizationWithSig` recovers the signatory with ecrecover and requires
 * `authorization.authorizer == signatory`, so the decoder requires `authorizer` to be the signer;
 * an authorized account can withdraw, borrow and withdrawCollateral on the signer's behalf with an
 * arbitrary receiver. The document decodes on ANY verifyingContract — the `verified` flag tells the
 * prompt whether it is a deployment of the table below.
 *
 * Aave v3 (aave-dao/aave-v3-origin@8305565 `DebtTokenBase.sol`: `DelegationWithSig(address
 * delegatee,uint256 value,uint256 nonce,uint256 deadline)` under the four-field domain at version
 * `"1"`): `delegationWithSig` recovers the delegator from the signature — the signer is the
 * delegator by construction — and sets `_borrowAllowances[delegator][delegatee] = value`. A
 * variable-debt token of the table below is verified and its amount displayed in the underlying
 * asset's units; any other contract is unverified and the amount stays raw.
 */
import { MAX_UINT256 } from "./approval.ts";
import { lookupEvmToken } from "./tokens.ts";
import type { EvmTokenTable } from "./tokens.ts";
import {
  domainChainId,
  MAX_UINT48,
  sameFields,
  typedDataAddress,
  typedDataUint,
} from "./typed-data.ts";
import type { TypedDataInput } from "./typed-data.ts";

/* The Morpho Blue deployments of https://docs.morpho.org/get-started/resources/addresses/
   (Morpho Blue section), per wallet network — each entry's code and DOMAIN_SEPARATOR() is probed
   on-chain by scripts/vectors/account-authority.ts. */
export const MORPHO_BLUE: Readonly<Record<string, string>> = {
  "1": "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  "10": "0xce95AfbB8EA029495c66020883F87aaE8864AF92",
  "14": "0xF4346F5132e810f80a28487a79c7559d9797E8B0",
  "25": "0xDF9a1DC07e5dEe5ccCCaBeC35e446C70fAF7434e",
  "56": "0x01b0Bd309AA75547f7a37Ad7B1219A898E67a83a",
  "100": "0xB74D4dd451E250bC325AFF0556D717e4E2351c66",
  "130": "0x8f5ae9CddB9f68de460C77730b018Ae7E04a140A",
  "137": "0x1bF0c2541F820E775182832f06c0B7Fc27A25f67",
  "143": "0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee",
  "146": "0xd6c916eB7542D0Ad3f18AEd0FCBD50C582cfa95f",
  "196": "0xeb00C490E888286357dC5B0a35D37D9260D11Ab5",
  "252": "0xa6030627d724bA78a59aCf43Be7550b4C5a0653b",
  "480": "0xE741BC7c34758b4caE05062794E8Ae24978AF432",
  "999": "0x68e37dE8d93d3496ae143F2E900490f6280C57cD",
  "1329": "0xc9cDAc20FCeAAF616f7EB0bb6Cd2c69dcfa9094c",
  "1672": "0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb",
  "1868": "0xE75Fc5eA6e74B824954349Ca351eb4e671ADA53a",
  "43114": "0x895383274303AA19fe978AFB4Ac55C7f094f982C",
  "42220": "0xd24ECdD8C1e0E57a4E26B1a7bbeAa3e95466A569",
  "4326": "0x18120312A7cf44DcfEc6dCe5632a431579ED9100",
  "8453": "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  "9745": "0x2fF74A46536f5c67ef5A42FD5B4e2Ed8A2cee249",
  "57073": "0x857f3EefE8cbda3Bc49367C996cd664A880d3042",
  "59144": "0x6B0D716aC0A45536172308e08fC2C40387262c9F",
  "747474": "0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc",
  "534352": "0x2d012EdbAdc37eDc2BC62791B666f9193FDF5a55",
  "84532": "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  "11155111": "0xd011EE229E7459ba1ddd22631eF7bF528d424A14",
};

/* Aave v3 variable-debt tokens (debtToken → underlying), from the market files of
   bgd-labs/aave-address-book@1f174c27365f7a74a19f8b5b988b1394b9d3d112 (`src/AaveV3*.sol`), kept
   only where the underlying is in the built-in token table; every entry's
   POOL.getReserveData(underlying).variableDebtTokenAddress, UNDERLYING_ASSET_ADDRESS() and
   DOMAIN_SEPARATOR() is probed on-chain by scripts/vectors/account-authority.ts. */
export const AAVE_DEBT_TOKENS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // AaveV3Ethereum / EtherFi / Horizon / Lido
  "1": {
    "0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    "0x72E95b8931767C79bA4EeE721354d6E99a61D004": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "0x6df1C1E379bC5a00a7b4C6e67A203333772f45A8": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    "0x9355032d747f1e08F8720CD01950E652eE15cdB7": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "0x4139EcBe83d78ef5EFF0A6eDA6f894Be9D590FC7": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "0x91b7d78BF92db564221f6B5AeE744D1727d1Dd1e": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    "0xeD90dE2D824Ee766c6Fd22E90b12e598f681dc9F": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  // AaveV3Optimism
  "10": {
    "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351": "0x4200000000000000000000000000000000000006",
    "0x5D557B07776D12967914379C71a1310e917C7555": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  },
  // AaveV3BNB
  "56": {
    "0x0E76414d433ddfe8004d2A7505d218874875a996": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  },
  // AaveV3Gnosis — no listed reserve underlyings
  // AaveV3Polygon
  "137": {
    "0x4a1c3aD6Ed28a636ee1751C69071f6be75DEb8B8": "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    "0xE701126012EC0290822eEA17B794454d1AF8b030": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  },
  // AaveV3Monad
  "143": {
    "0x9F555aB84C4e0a531B50283f09Dba7A97134c4e4": "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  },
  // AaveV3Sonic
  "146": {
    "0x2273caBAd63b7D247A6b107E723c803fc49953A0": "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
    "0xF6089B790Fbf8F4812a79a31CFAbeB00B06BA7BD": "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38",
  },
  // AaveV3XLayer
  "196": {
    "0x585Eb919387F82bc9B2B440C4F3D8615B079465A": "0xB6CEceAB302E2E4948951eE7843FC24E92933061",
  },
  // AaveV3ZkSync
  "324": {
    "0x0049250D15A8550c5a14Baa5AF5B662a93a525B9": "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4",
  },
  // AaveV3MegaEth
  "4326": {
    "0x09ADCCC7AF2aBD356c18A4CadF2e5cC250f300E9": "0x4200000000000000000000000000000000000006",
  },
  // AaveV3Soneium
  "1868": {
    "0xC52375A5A04C0ABe5a6Ca5F3a344be2415EF54dB": "0x4200000000000000000000000000000000000006",
  },
  // AaveV3Base
  "8453": {
    "0x24e6e0795b3c7c71D965fCc4f371803d1c1DcA1E": "0x4200000000000000000000000000000000000006",
    "0x59dca05b6c26dbd64b5381374aAaC5CD05644C28": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  // AaveV3Arbitrum
  "42161": {
    "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    "0xf611aEb5013fD2c0511c9CD55c7dc5C1140741A6": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  // AaveV3Celo
  "42220": {
    "0xDbe517c0FA6467873B684eCcbED77217E471E862": "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    "0xE15324a9887999803b931Ac45aa89a94A9750052": "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
    "0xaEa37B42955De2Ba2E4AF6581E46349bCD3Ea2d6": "0x471EcE3750Da237f93B8E339c536989b8978a438",
  },
  // AaveV3Avalanche
  "43114": {
    "0xFCCf3cAbbe80101232d343252614b6A3eE81C989": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    "0xfb00AC187a8Eb5AFAE4eACE434F493Eb62672df7": "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
    "0x4a1c3aD6Ed28a636ee1751C69071f6be75DEb8B8": "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
  },
  // AaveV3InkWhitelabel
  "57073": {
    "0xc1457AcfBaD2332b07B7651A4Da3176E8F3Bc9E4": "0x4200000000000000000000000000000000000006",
    "0x305c03f74DBb8C6052b7667AaBEE21dC7c1f0B29": "0x2D270e6886d130D724215A266106e6832161EAEd",
  },
  // AaveV3Linea
  "59144": {
    "0x63aB166e6E1b6Fb705b6ca23686FaD9705EB3534": "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
  },
  // AaveV3Scroll
  "534352": {
    "0xfD7344CeB1Df9Cf238EcD667f4A6F99c6Ef44a56": "0x5300000000000000000000000000000000000004",
  },
};

/** `address` is the Morpho Blue deployment of `chainId` (the `morpho-blue` family claim). */
export const isMorphoBlue = (chainId: number, address: string): boolean =>
  MORPHO_BLUE[String(chainId)]?.toLowerCase() === address.toLowerCase();

const MORPHO_DOMAIN = ["uint256 chainId", "address verifyingContract"] as const;
const MORPHO_FIELDS = [
  "address authorizer",
  "address authorized",
  "bool isAuthorized",
  "uint256 nonce",
  "uint256 deadline",
] as const;

const AAVE_DOMAIN = [
  "string name",
  "string version",
  "uint256 chainId",
  "address verifyingContract",
] as const;
const AAVE_FIELDS = [
  "address delegatee",
  "uint256 value",
  "uint256 nonce",
  "uint256 deadline",
] as const;

/* A declared uint256 field that must parse; the caller drops it from the content when it is at
   or beyond the uint48 display bound. */
const parseUint = (value: unknown): bigint | undefined => typedDataUint(value, MAX_UINT256);

export type AuthorityResult = {
  readonly content: { readonly authority: AccountAuthority };
  readonly summary: "authorization";
  readonly outflows: ReadonlyArray<never>;
  readonly verifiability: "partial";
};

const result = (authority: AccountAuthority): AuthorityResult => ({
  content: { authority },
  summary: "authorization",
  outflows: [],
  verifiability: "partial",
});

/**
 * The authority the document grants, or `undefined` when the shape is not exactly a Morpho Blue
 * `Authorization` bound to the signer or an Aave `DelegationWithSig` on `chainId`.
 */
export function recognizeAuthority(
  json: TypedDataInput,
  chainId: number,
  table: EvmTokenTable,
  signer: string,
): AuthorityResult | undefined {
  const { types, primaryType, message, domain } = json;
  if (Object.keys(types).length !== 2 || domainChainId(domain) !== chainId) {
    return undefined;
  }
  const contract = typedDataAddress(domain["verifyingContract"]);
  if (contract === undefined) {
    return undefined;
  }
  if (primaryType === "Authorization") {
    if (
      !sameFields(types, "EIP712Domain", MORPHO_DOMAIN) ||
      !sameFields(types, "Authorization", MORPHO_FIELDS)
    ) {
      return undefined;
    }
    const authorizer = typedDataAddress(message["authorizer"]);
    const authorized = typedDataAddress(message["authorized"]);
    const { isAuthorized } = message;
    const nonce = parseUint(message["nonce"]);
    const deadline = parseUint(message["deadline"]);
    if (
      authorizer === undefined ||
      authorizer.toLowerCase() !== signer.toLowerCase() ||
      authorized === undefined ||
      typeof isAuthorized !== "boolean" ||
      nonce === undefined ||
      deadline === undefined
    ) {
      return undefined;
    }
    return result({
      kind: "morpho",
      contract,
      verified: isMorphoBlue(chainId, contract),
      authorized,
      grant: isAuthorized,
      ...(deadline <= MAX_UINT48 ? { deadline: Number(deadline) } : {}),
    });
  }
  if (primaryType === "DelegationWithSig") {
    if (
      !sameFields(types, "EIP712Domain", AAVE_DOMAIN) ||
      !sameFields(types, "DelegationWithSig", AAVE_FIELDS) ||
      typeof domain["name"] !== "string" ||
      domain["version"] !== "1"
    ) {
      return undefined;
    }
    const delegatee = typedDataAddress(message["delegatee"]);
    const value = parseUint(message["value"]);
    const nonce = parseUint(message["nonce"]);
    const deadline = parseUint(message["deadline"]);
    if (
      delegatee === undefined ||
      value === undefined ||
      nonce === undefined ||
      deadline === undefined
    ) {
      return undefined;
    }
    const underlying = AAVE_DEBT_TOKENS[String(chainId)]?.[contract];
    const listed =
      underlying === undefined ? undefined : lookupEvmToken(table, chainId, underlying);
    const amount: AssetAmount =
      underlying === undefined
        ? { asset: contract, amount: value.toString() }
        : {
            asset: underlying,
            amount: value.toString(),
            ...(listed === undefined ? {} : { symbol: listed.symbol, decimals: listed.decimals }),
          };
    return result({
      kind: "aave-credit",
      contract,
      verified: underlying !== undefined,
      delegatee,
      amount,
      unlimited: value === MAX_UINT256,
      ...(deadline <= MAX_UINT48 ? { deadline: Number(deadline) } : {}),
    });
  }
  return undefined;
}
