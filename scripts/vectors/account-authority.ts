/// <reference types="node" />
// oxlint-disable eslint/no-await-in-loop -- requests are sequential and throttled by design
/**
 * Regenerates vectors/chains/account-authority.json: on-chain probes for every contract the
 * account-authority decoders recognise (packages/wallet-chains/src/evm/authority.ts and
 * src/evm/farcaster.ts) plus signed documents of each family.
 *
 * Probes:
 *
 * - Morpho Blue deployments (the MORPHO_BLUE table — addresses from
 *   https://docs.morpho.org/get-started/resources/addresses/, Morpho Blue section): code is present
 *   and DOMAIN_SEPARATOR() equals the EIP-712 domain hash of `EIP712Domain(uint256 chainId,address
 *   verifyingContract)` (morpho-org/morpho-blue@339a885 ConstantsLib.sol).
 * - Aave v3 variable-debt tokens (the AAVE_DEBT_TOKENS table — market files of
 *   bgd-labs/aave-address-book@1f174c27365f7a74a19f8b5b988b1394b9d3d112): code is present,
 *   POOL.getReserveData(underlying).variableDebtTokenAddress is the debt token,
 *   UNDERLYING_ASSET_ADDRESS() is the underlying, and DOMAIN_SEPARATOR() is the EIP-712 domain hash
 *   of {name: name(), version: "1", chainId, verifyingContract} (aave-dao/aave-v3-origin@8305565
 *   DebtTokenBase.sol).
 * - Farcaster KeyGateway and SignedKeyRequestValidator on OP Mainnet
 *   (farcasterxyz/contracts@9894509): eip712Domain() reports the contract itself under `Farcaster
 *   KeyGateway`/`Farcaster SignedKeyRequestValidator` version "1" chain id 10.
 *
 * The `docs` section carries one signed document per family shape (Morpho grant and revoke, Aave
 * unlimited credit and a bounded credit on an unverified contract, a Snapshot Alias, a Farcaster
 * Add with the real `abi.encode(SignedKeyRequestMetadata)` tuple payload, and a SignedKeyRequest),
 * each with its viem `hashTypedData` digest and a signature from the fixed test key; for Morpho and
 * Aave the digest is additionally recomputed as `keccak256(0x1901 ‖ domainSeparator ‖
 * keccak256(abi.encode(TYPEHASH, …)))` with the TYPEHASH from the cited source and asserted equal.
 *
 * Run from the repo root: bun scripts/vectors/account-authority.ts
 */
import { writeFileSync } from "node:fs";

import {
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const OUT = "vectors/chains/account-authority.json";
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const account = privateKeyToAccount(TEST_KEY);

const RPCS: Record<number, string> = {
  1: "https://ethereum-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  14: "https://flare-api.flare.network/ext/C/rpc",
  25: "https://cronos-evm-rpc.publicnode.com",
  56: "https://bsc-rpc.publicnode.com",
  100: "https://gnosis-rpc.publicnode.com",
  130: "https://unichain-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com",
  143: "https://rpc.monad.xyz",
  146: "https://sonic-rpc.publicnode.com",
  196: "https://rpc.xlayer.tech",
  252: "https://fraxtal-rpc.publicnode.com",
  324: "https://mainnet.era.zksync.io",
  480: "https://worldchain-mainnet.g.alchemy.com/public",
  999: "https://rpc.hyperliquid.xyz/evm",
  1329: "https://sei-evm-rpc.publicnode.com",
  1672: "https://rpc.pharos.xyz",
  1868: "https://soneium-rpc.publicnode.com",
  4326: "https://mainnet.megaeth.com/rpc",
  8453: "https://base-rpc.publicnode.com",
  9745: "https://rpc.plasma.to",
  42161: "https://arbitrum-one-rpc.publicnode.com",
  42220: "https://celo-rpc.publicnode.com",
  43114: "https://avalanche-c-chain-rpc.publicnode.com",
  4663: "https://rpc.chain.robinhood.com",
  5042: "https://rpc.arc.network",
  57073: "https://ink-rpc.publicnode.com",
  59144: "https://linea-rpc.publicnode.com",
  747474: "https://rpc.katana.network",
  534352: "https://scroll-rpc.publicnode.com",
  84532: "https://base-sepolia-rpc.publicnode.com",
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
};

/* Mirrors MORPHO_BLUE in packages/wallet-chains/src/evm/authority.ts — keep in sync. */
const MORPHO_BLUE: Record<number, string> = {
  1: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  10: "0xce95AfbB8EA029495c66020883F87aaE8864AF92",
  14: "0xF4346F5132e810f80a28487a79c7559d9797E8B0",
  25: "0xDF9a1DC07e5dEe5ccCCaBeC35e446C70fAF7434e",
  56: "0x01b0Bd309AA75547f7a37Ad7B1219A898E67a83a",
  100: "0xB74D4dd451E250bC325AFF0556D717e4E2351c66",
  130: "0x8f5ae9CddB9f68de460C77730b018Ae7E04a140A",
  137: "0x1bF0c2541F820E775182832f06c0B7Fc27A25f67",
  143: "0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee",
  146: "0xd6c916eB7542D0Ad3f18AEd0FCBD50C582cfa95f",
  196: "0xeb00C490E888286357dC5B0a35D37D9260D11Ab5",
  252: "0xa6030627d724bA78a59aCf43Be7550b4C5a0653b",
  480: "0xE741BC7c34758b4caE05062794E8Ae24978AF432",
  999: "0x68e37dE8d93d3496ae143F2E900490f6280C57cD",
  1329: "0xc9cDAc20FCeAAF616f7EB0bb6Cd2c69dcfa9094c",
  1672: "0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb",
  1868: "0xE75Fc5eA6e74B824954349Ca351eb4e671ADA53a",
  43114: "0x895383274303AA19fe978AFB4Ac55C7f094f982C",
  42220: "0xd24ECdD8C1e0E57a4E26B1a7bbeAa3e95466A569",
  4326: "0x18120312A7cf44DcfEc6dCe5632a431579ED9100",
  8453: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  9745: "0x2fF74A46536f5c67ef5A42FD5B4e2Ed8A2cee249",
  57073: "0x857f3EefE8cbda3Bc49367C996cd664A880d3042",
  59144: "0x6B0D716aC0A45536172308e08fC2C40387262c9F",
  747474: "0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc",
  534352: "0x2d012EdbAdc37eDc2BC62791B666f9193FDF5a55",
  84532: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  11155111: "0xd011EE229E7459ba1ddd22631eF7bF528d424A14",
};

/* Mirrors AAVE_DEBT_TOKENS — market file, pool, debt token and underlying per reserve. */
const AAVE_DEBT: ReadonlyArray<{
  readonly chainId: number;
  readonly market: string;
  readonly pool: string;
  readonly debtToken: string;
  readonly underlying: string;
}> = [
  {
    chainId: 1,
    market: "AaveV3Ethereum",
    pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    debtToken: "0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE",
    underlying: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
  {
    chainId: 1,
    market: "AaveV3Ethereum",
    pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    debtToken: "0x72E95b8931767C79bA4EeE721354d6E99a61D004",
    underlying: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  {
    chainId: 1,
    market: "AaveV3Ethereum",
    pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    debtToken: "0x6df1C1E379bC5a00a7b4C6e67A203333772f45A8",
    underlying: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  },
  {
    chainId: 1,
    market: "AaveV3EthereumEtherFi",
    pool: "0x0AA97c284e98396202b6A04024F5E2c65026F3c0",
    debtToken: "0x9355032d747f1e08F8720CD01950E652eE15cdB7",
    underlying: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  {
    chainId: 1,
    market: "AaveV3EthereumHorizon",
    pool: "0xAe05Cd22df81871bc7cC2a04BeCfb516bFe332C8",
    debtToken: "0x4139EcBe83d78ef5EFF0A6eDA6f894Be9D590FC7",
    underlying: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  {
    chainId: 1,
    market: "AaveV3EthereumLido",
    pool: "0x4e033931ad43597d96D6bcc25c280717730B58B1",
    debtToken: "0x91b7d78BF92db564221f6B5AeE744D1727d1Dd1e",
    underlying: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
  {
    chainId: 1,
    market: "AaveV3EthereumLido",
    pool: "0x4e033931ad43597d96D6bcc25c280717730B58B1",
    debtToken: "0xeD90dE2D824Ee766c6Fd22E90b12e598f681dc9F",
    underlying: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  {
    chainId: 10,
    market: "AaveV3Optimism",
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    debtToken: "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351",
    underlying: "0x4200000000000000000000000000000000000006",
  },
  {
    chainId: 10,
    market: "AaveV3Optimism",
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    debtToken: "0x5D557B07776D12967914379C71a1310e917C7555",
    underlying: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  },
  {
    chainId: 56,
    market: "AaveV3BNB",
    pool: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
    debtToken: "0x0E76414d433ddfe8004d2A7505d218874875a996",
    underlying: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  },
  {
    chainId: 137,
    market: "AaveV3Polygon",
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    debtToken: "0x4a1c3aD6Ed28a636ee1751C69071f6be75DEb8B8",
    underlying: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  },
  {
    chainId: 137,
    market: "AaveV3Polygon",
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    debtToken: "0xE701126012EC0290822eEA17B794454d1AF8b030",
    underlying: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  },
  {
    chainId: 143,
    market: "AaveV3Monad",
    pool: "0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef",
    debtToken: "0x9F555aB84C4e0a531B50283f09Dba7A97134c4e4",
    underlying: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  },
  {
    chainId: 146,
    market: "AaveV3Sonic",
    pool: "0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3",
    debtToken: "0x2273caBAd63b7D247A6b107E723c803fc49953A0",
    underlying: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
  },
  {
    chainId: 146,
    market: "AaveV3Sonic",
    pool: "0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3",
    debtToken: "0xF6089B790Fbf8F4812a79a31CFAbeB00B06BA7BD",
    underlying: "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38",
  },
  {
    chainId: 196,
    market: "AaveV3XLayer",
    pool: "0xE3F3Caefdd7180F884c01E57f65Df979Af84f116",
    debtToken: "0x585Eb919387F82bc9B2B440C4F3D8615B079465A",
    underlying: "0xB6CEceAB302E2E4948951eE7843FC24E92933061",
  },
  {
    chainId: 324,
    market: "AaveV3ZkSync",
    pool: "0x78e30497a3c7527d953c6B1E3541b021A98Ac43c",
    debtToken: "0x0049250D15A8550c5a14Baa5AF5B662a93a525B9",
    underlying: "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4",
  },
  {
    chainId: 4326,
    market: "AaveV3MegaEth",
    pool: "0x7e324AbC5De01d112AfC03a584966ff199741C28",
    debtToken: "0x09ADCCC7AF2aBD356c18A4CadF2e5cC250f300E9",
    underlying: "0x4200000000000000000000000000000000000006",
  },
  {
    chainId: 1868,
    market: "AaveV3Soneium",
    pool: "0xDd3d7A7d03D9fD9ef45f3E587287922eF65CA38B",
    debtToken: "0xC52375A5A04C0ABe5a6Ca5F3a344be2415EF54dB",
    underlying: "0x4200000000000000000000000000000000000006",
  },
  {
    chainId: 8453,
    market: "AaveV3Base",
    pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    debtToken: "0x24e6e0795b3c7c71D965fCc4f371803d1c1DcA1E",
    underlying: "0x4200000000000000000000000000000000000006",
  },
  {
    chainId: 8453,
    market: "AaveV3Base",
    pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    debtToken: "0x59dca05b6c26dbd64b5381374aAaC5CD05644C28",
    underlying: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  {
    chainId: 42161,
    market: "AaveV3Arbitrum",
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    debtToken: "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351",
    underlying: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  },
  {
    chainId: 42161,
    market: "AaveV3Arbitrum",
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    debtToken: "0xf611aEb5013fD2c0511c9CD55c7dc5C1140741A6",
    underlying: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  {
    chainId: 42220,
    market: "AaveV3Celo",
    pool: "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402",
    debtToken: "0xDbe517c0FA6467873B684eCcbED77217E471E862",
    underlying: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
  },
  {
    chainId: 42220,
    market: "AaveV3Celo",
    pool: "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402",
    debtToken: "0xE15324a9887999803b931Ac45aa89a94A9750052",
    underlying: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
  },
  {
    chainId: 42220,
    market: "AaveV3Celo",
    pool: "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402",
    debtToken: "0xaEa37B42955De2Ba2E4AF6581E46349bCD3Ea2d6",
    underlying: "0x471EcE3750Da237f93B8E339c536989b8978a438",
  },
  {
    chainId: 43114,
    market: "AaveV3Avalanche",
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    debtToken: "0xFCCf3cAbbe80101232d343252614b6A3eE81C989",
    underlying: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  },
  {
    chainId: 43114,
    market: "AaveV3Avalanche",
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    debtToken: "0xfb00AC187a8Eb5AFAE4eACE434F493Eb62672df7",
    underlying: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
  },
  {
    chainId: 43114,
    market: "AaveV3Avalanche",
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    debtToken: "0x4a1c3aD6Ed28a636ee1751C69071f6be75DEb8B8",
    underlying: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
  },
  {
    chainId: 57073,
    market: "AaveV3InkWhitelabel",
    pool: "0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA",
    debtToken: "0xc1457AcfBaD2332b07B7651A4Da3176E8F3Bc9E4",
    underlying: "0x4200000000000000000000000000000000000006",
  },
  {
    chainId: 57073,
    market: "AaveV3InkWhitelabel",
    pool: "0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA",
    debtToken: "0x305c03f74DBb8C6052b7667AaBEE21dC7c1f0B29",
    underlying: "0x2D270e6886d130D724215A266106e6832161EAEd",
  },
  {
    chainId: 59144,
    market: "AaveV3Linea",
    pool: "0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac",
    debtToken: "0x63aB166e6E1b6Fb705b6ca23686FaD9705EB3534",
    underlying: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
  },
  {
    chainId: 534352,
    market: "AaveV3Scroll",
    pool: "0x11fCfe756c05AD438e312a7fd934381537D3cFfe",
    debtToken: "0xfD7344CeB1Df9Cf238EcD667f4A6F99c6Ef44a56",
    underlying: "0x5300000000000000000000000000000000000004",
  },
];

const FARCASTER: ReadonlyArray<{ readonly label: string; readonly address: string }> = [
  { label: "key-gateway", address: "0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B" },
  { label: "signed-key-request-validator", address: "0x00000000FC700472606ED4fA22623Acf62c60553" },
];

const POOL_ABI = parseAbi([
  "function getReserveData(address asset) view returns (uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128)",
]);
const TOKEN_ABI = parseAbi([
  "function UNDERLYING_ASSET_ADDRESS() view returns (address)",
  "function name() view returns (string)",
]);

const MORPHO_DOMAIN_TYPEHASH = keccak256(
  stringToHex("EIP712Domain(uint256 chainId,address verifyingContract)"),
);
const MORPHO_TYPEHASH = keccak256(
  stringToHex(
    "Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)",
  ),
);
const AAVE_DOMAIN_TYPEHASH = keccak256(
  stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);
const AAVE_TYPEHASH = keccak256(
  stringToHex("DelegationWithSig(address delegatee,uint256 value,uint256 nonce,uint256 deadline)"),
);

const morphoSeparator = (chainId: number, contract: `0x${string}`) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [MORPHO_DOMAIN_TYPEHASH, BigInt(chainId), contract],
    ),
  );

const aaveSeparator = (name: string, chainId: number, contract: `0x${string}`) =>
  keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        AAVE_DOMAIN_TYPEHASH,
        keccak256(stringToHex(name)),
        keccak256(stringToHex("1")),
        BigInt(chainId),
        contract,
      ],
    ),
  );

const call = async (url: string, method: string, params: unknown[]): Promise<unknown> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      const json: unknown = await response.json();
      if (json !== null && typeof json === "object" && "error" in json) {
        return undefined;
      }
      return json !== null && typeof json === "object" && "result" in json
        ? json.result
        : undefined;
    } catch {
      /* retry */
    }
  }
  return undefined;
};

const ethCall = async (url: string, to: string, data: `0x${string}`) =>
  call(url, "eth_call", [{ to, data }, "latest"]);
const getCode = async (url: string, address: string) =>
  call(url, "eth_getCode", [address, "latest"]);
const nap = async () =>
  new Promise((resolve) => {
    setTimeout(resolve, 150);
  });

type MorphoProbe = {
  readonly chainId: number;
  readonly address: string;
  codePresent: boolean;
  domainSeparator?: string;
  expectedSeparator: string;
  ok?: boolean;
  note?: string;
};

type AaveProbe = {
  readonly chainId: number;
  readonly market: string;
  readonly debtToken: string;
  readonly underlying: string;
  codePresent: boolean;
  reserveDebtToken?: string;
  underlyingAsset?: string;
  name?: string;
  domainSeparator?: string;
  expectedSeparator?: string;
  ok?: boolean;
  note?: string;
};

type FarcasterProbe = {
  readonly label: string;
  readonly chainId: 10;
  readonly address: string;
  codePresent: boolean;
  name?: string;
  version?: string;
  domainChainId?: number;
  verifyingContract?: string;
  ok?: boolean;
};

const morphoProbes: MorphoProbe[] = [];
for (const [chain, address] of Object.entries(MORPHO_BLUE)) {
  const chainId = Number(chain);
  const probe: MorphoProbe = {
    chainId,
    address,
    codePresent: false,
    expectedSeparator: morphoSeparator(chainId, getAddress(address)),
  };
  const url = RPCS[chainId];
  if (url === undefined) {
    probe.note = "no public RPC configured for this chain";
  } else {
    const code = await getCode(url, address);
    probe.codePresent = typeof code === "string" && code !== "0x";
    if (probe.codePresent) {
      const separator = await ethCall(url, address, "0x3644e515");
      if (typeof separator === "string" && separator.length === 66) {
        probe.domainSeparator = separator;
        probe.ok = separator === probe.expectedSeparator;
      }
    }
    await nap();
  }
  morphoProbes.push(probe);
  console.log(
    "morpho",
    chainId,
    address.slice(0, 10),
    probe.ok === true ? "ok" : (probe.note ?? "FAIL"),
  );
}

const aaveProbes: AaveProbe[] = [];
for (const reserve of AAVE_DEBT) {
  const probe: AaveProbe = { ...reserve, codePresent: false };
  const url = RPCS[reserve.chainId];
  if (url === undefined) {
    probe.note = "no public RPC configured for this chain";
  } else {
    const code = await getCode(url, reserve.debtToken);
    probe.codePresent = typeof code === "string" && code !== "0x";
    if (probe.codePresent) {
      const reserveData = await ethCall(
        url,
        reserve.pool,
        encodeFunctionData({
          abi: POOL_ABI,
          functionName: "getReserveData",
          args: [getAddress(reserve.underlying)],
        }),
      );
      if (typeof reserveData === "string" && reserveData.length > 2) {
        const reserveTuple = decodeAbiParameters(POOL_ABI[0].outputs, `0x${reserveData.slice(2)}`);
        /* ReserveDataLegacy field 10 is variableDebtTokenAddress. */
        probe.reserveDebtToken = getAddress(reserveTuple[10]);
      }
      const underlyingAsset = await ethCall(
        url,
        reserve.debtToken,
        encodeFunctionData({ abi: TOKEN_ABI, functionName: "UNDERLYING_ASSET_ADDRESS" }),
      );
      if (typeof underlyingAsset === "string" && underlyingAsset.length >= 66) {
        probe.underlyingAsset = getAddress(`0x${underlyingAsset.slice(-40)}`);
      }
      const name = await ethCall(
        url,
        reserve.debtToken,
        encodeFunctionData({ abi: TOKEN_ABI, functionName: "name" }),
      );
      if (typeof name === "string" && name.length > 2) {
        const [tokenName] = decodeAbiParameters([{ type: "string" }], `0x${name.slice(2)}`);
        probe.name = tokenName;
        probe.expectedSeparator = aaveSeparator(
          tokenName,
          reserve.chainId,
          getAddress(reserve.debtToken),
        );
        const separator = await ethCall(url, reserve.debtToken, "0x3644e515");
        if (typeof separator === "string" && separator.length === 66) {
          probe.domainSeparator = separator;
          probe.ok =
            separator === probe.expectedSeparator &&
            probe.reserveDebtToken === getAddress(reserve.debtToken) &&
            probe.underlyingAsset === getAddress(reserve.underlying);
        }
      }
    }
    await nap();
  }
  aaveProbes.push(probe);
  console.log(
    "aave",
    reserve.chainId,
    reserve.debtToken.slice(0, 10),
    probe.ok === true ? "ok" : (probe.note ?? "FAIL"),
  );
}

const farcasterProbes: FarcasterProbe[] = [];
for (const target of FARCASTER) {
  const probe: FarcasterProbe = {
    label: target.label,
    chainId: 10,
    address: target.address,
    codePresent: false,
  };
  const code = await getCode(RPCS[10] ?? "", target.address);
  probe.codePresent = typeof code === "string" && code !== "0x";
  if (probe.codePresent) {
    const domain = await ethCall(RPCS[10] ?? "", target.address, "0x84b0196e");
    if (typeof domain === "string" && domain.length > 2) {
      const [, name, version, chainId, verifyingContract] = decodeAbiParameters(
        [
          { type: "bytes1" },
          { type: "string" },
          { type: "string" },
          { type: "uint256" },
          { type: "address" },
          { type: "bytes32" },
          { type: "uint256[]" },
        ],
        `0x${domain.slice(2)}`,
      );
      probe.name = name;
      probe.version = version;
      probe.domainChainId = Number(chainId);
      probe.verifyingContract = verifyingContract;
      probe.ok =
        name ===
          `Farcaster ${target.label === "key-gateway" ? "KeyGateway" : "SignedKeyRequestValidator"}` &&
        version === "1" &&
        probe.domainChainId === 10 &&
        verifyingContract.toLowerCase() === target.address.toLowerCase();
    }
  }
  farcasterProbes.push(probe);
  console.log("farcaster", target.label, probe.ok === true ? "ok" : "FAIL");
  await nap();
}

/* ---- signed documents ---- */

const OTHER = "0x00000000000000000000000000000000C0FfeE00";
const KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as `0x${string}`;

type Doc = {
  readonly types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  readonly primaryType: string;
  readonly domain: Record<string, unknown>;
  readonly message: Record<string, unknown>;
};

const morphoDoc = (grant: boolean): Doc => ({
  types: {
    EIP712Domain: [
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Authorization: [
      { name: "authorizer", type: "address" },
      { name: "authorized", type: "address" },
      { name: "isAuthorized", type: "bool" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Authorization",
  domain: { chainId: 1, verifyingContract: getAddress(MORPHO_BLUE[1] ?? "") },
  message: {
    authorizer: account.address,
    authorized: OTHER,
    isAuthorized: grant,
    nonce: "0",
    deadline: "1900000000",
  },
});

const aaveDoc = (value: string, contract: string): Doc => ({
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    DelegationWithSig: [
      { name: "delegatee", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "DelegationWithSig",
  domain: {
    name: "Aave Ethereum Variable Debt USDC",
    version: "1",
    chainId: 1,
    verifyingContract: contract,
  },
  message: { delegatee: OTHER, value, nonce: "0", deadline: "1900000000" },
});

const snapshotAliasDoc: Doc = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
    ],
    Alias: [
      { name: "from", type: "address" },
      { name: "alias", type: "address" },
      { name: "timestamp", type: "uint64" },
    ],
  },
  primaryType: "Alias",
  domain: { name: "snapshot", version: "0.1.4" },
  message: { from: account.address, alias: OTHER, timestamp: 1700000000 },
};

/* SignedKeyRequestMetadata = abi.encode of the single tuple — the KeyGateway expects
   metadata = abi.encode(requestFid, requestSigner, signature, deadline)
   (farcasterxyz/contracts@9894509 src/validators/SignedKeyRequestValidator.sol). */
const FARCASTER_METADATA = encodeAbiParameters(
  [
    {
      type: "tuple",
      components: [
        { name: "requestFid", type: "uint256" },
        { name: "requestSigner", type: "address" },
        { name: "signature", type: "bytes" },
        { name: "deadline", type: "uint256" },
      ],
    },
  ],
  [
    {
      requestFid: 42n,
      requestSigner: OTHER,
      signature:
        "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      deadline: 1900000000n,
    },
  ],
);

const farcasterAddDoc: Doc = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Add: [
      { name: "owner", type: "address" },
      { name: "keyType", type: "uint32" },
      { name: "key", type: "bytes" },
      { name: "metadataType", type: "uint8" },
      { name: "metadata", type: "bytes" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Add",
  domain: {
    name: "Farcaster KeyGateway",
    version: "1",
    chainId: 10,
    verifyingContract: "0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B",
  },
  message: {
    owner: account.address,
    keyType: 1,
    key: KEY,
    metadataType: 1,
    metadata: FARCASTER_METADATA,
    nonce: "0",
    deadline: "1900000000",
  },
};

const farcasterRequestDoc: Doc = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    SignedKeyRequest: [
      { name: "requestFid", type: "uint256" },
      { name: "key", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "SignedKeyRequest",
  domain: {
    name: "Farcaster SignedKeyRequestValidator",
    version: "1",
    chainId: 10,
    verifyingContract: "0x00000000FC700472606ED4fA22623Acf62c60553",
  },
  message: { requestFid: "42", key: KEY, deadline: "1900000000" },
};

/* viem wants declared uint fields as bigint and checksummed addresses; everything else passes. */
const viemArgs = (data: Doc): never => {
  const args = {
    domain: data.domain,
    types: data.types,
    primaryType: data.primaryType,
    message: Object.fromEntries(
      Object.entries(data.message).map(([key, value]) => {
        const declared = data.types[data.primaryType]?.find((field) => field.name === key);
        return [
          key,
          typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
            ? value.toLowerCase()
            : declared !== undefined && declared.type.startsWith("uint")
              ? BigInt(String(value))
              : value,
        ];
      }),
    ),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- identical runtime shape; viem's TypedData types are nominal
  return args as never;
};

const str = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new TypeError("expected a string field");
  }
  return value;
};
const addr = (value: unknown): `0x${string}` => {
  const text = str(value);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the regex above fixes the shape
  return text as `0x${string}`;
};

const digest = (data: Doc) => hashTypedData(viemArgs(data));

const docs: Array<{
  name: string;
  network: string;
  data: Doc;
  digest: string;
  signature: string;
  manualDigest?: string;
}> = [];

const push = async (name: string, network: string, data: Doc, manual?: () => string) => {
  const dig = digest(data);
  const signature = await account.signTypedData(viemArgs(data));
  const manualDigest = manual?.();
  if (manualDigest !== undefined && manualDigest !== dig) {
    throw new Error(`${name}: manual digest ${manualDigest} != viem ${dig}`);
  }
  docs.push({
    name,
    network,
    data,
    digest: dig,
    signature,
    ...(manualDigest === undefined ? {} : { manualDigest }),
  });
};

await push("morpho grant", "eip155:1", morphoDoc(true), () => {
  const m = morphoDoc(true).message;
  const struct = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "bool" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        MORPHO_TYPEHASH,
        addr(m["authorizer"]),
        addr(m["authorized"]),
        m["isAuthorized"] === true,
        BigInt(str(m["nonce"])),
        BigInt(str(m["deadline"])),
      ],
    ),
  );
  return keccak256(
    concat(["0x1901", morphoSeparator(1, getAddress(MORPHO_BLUE[1] ?? "")), struct]),
  );
});

await push("morpho revoke", "eip155:1", morphoDoc(false), () => {
  const m = morphoDoc(false).message;
  const struct = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "bool" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        MORPHO_TYPEHASH,
        addr(m["authorizer"]),
        addr(m["authorized"]),
        m["isAuthorized"] === true,
        BigInt(str(m["nonce"])),
        BigInt(str(m["deadline"])),
      ],
    ),
  );
  return keccak256(
    concat(["0x1901", morphoSeparator(1, getAddress(MORPHO_BLUE[1] ?? "")), struct]),
  );
});

const AAVE_USDC_DEBT = "0x72E95b8931767C79bA4EeE721354d6E99a61D004";
const aaveManual = (data: Doc) => () => {
  const m = data.message;
  const struct = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        AAVE_TYPEHASH,
        addr(m["delegatee"]),
        BigInt(str(m["value"])),
        BigInt(str(m["nonce"])),
        BigInt(str(m["deadline"])),
      ],
    ),
  );
  return keccak256(
    concat([
      "0x1901",
      aaveSeparator("Aave Ethereum Variable Debt USDC", 1, addr(data.domain["verifyingContract"])),
      struct,
    ]),
  );
};

await push(
  "aave unlimited credit",
  "eip155:1",
  aaveDoc(
    "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    AAVE_USDC_DEBT,
  ),
  aaveManual(
    aaveDoc(
      "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      AAVE_USDC_DEBT,
    ),
  ),
);

await push("aave bounded credit unverified contract", "eip155:1", aaveDoc("1000000", OTHER));

await push("snapshot alias", "eip155:1", snapshotAliasDoc);
await push("farcaster add", "eip155:10", farcasterAddDoc);
await push("farcaster signed key request", "eip155:10", farcasterRequestDoc);

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      source: {
        morpho:
          "https://docs.morpho.org/get-started/resources/addresses/ (Morpho Blue section); morpho-org/morpho-blue@339a885 ConstantsLib.sol",
        aave: "bgd-labs/aave-address-book@1f174c27365f7a74a19f8b5b988b1394b9d3d112 src/AaveV3*.sol; aave-dao/aave-v3-origin@8305565 DebtTokenBase.sol",
        farcaster:
          "farcasterxyz/contracts@9894509 src/KeyGateway.sol, src/validators/SignedKeyRequestValidator.sol",
      },
      key: TEST_KEY,
      account: account.address,
      probes: { morpho: morphoProbes, aave: aaveProbes, farcaster: farcasterProbes },
      docs,
    },
    undefined,
    2,
  )}\n`,
);
console.log(
  `wrote ${OUT}: ${morphoProbes.length} morpho probes, ${aaveProbes.length} aave probes, ${farcasterProbes.length} farcaster probes, ${docs.length} docs`,
);
