/// <reference types="node" />
// oxlint-disable eslint/no-await-in-loop -- requests are sequential and throttled by design
/**
 * Regenerates vectors/chains/order-protocols.json: on-chain probes for every order-protocol
 * contract the EVM decoders recognise — 1inch v6/v5 routers and LOP v2 deployments, the CoW GPv2
 * settlement, UniswapX reactors, and every `contracts` claim row in
 * packages/wallet-chains/src/families.ts (0x, Blur, LooksRare, Bebop, Paraswap, Velora Delta,
 * KyberSwap, OpenOcean, Odos).
 *
 * The (label, chainId, address) deployment list is the verified map behind those tables — upstream
 * addresses come from the pinned sources cited in the family rows (UniswapX README at
 * eb7ce077036258b9510b42ad37aa920cf3aaf308, 1inch/limit-order-protocol tag 4.0.0
 * c8be9c67247880bd6ec88cf7ad2e040a16a483f2, cowprotocol/contracts ea0c3659, the erc7730 registry at
 * 3d332d5f, openocean-finance/limit-order-protocol-v2 at 747ed8ea). The oracle is the public RPC
 * set below; each record is probed with eth_getCode, eip712Domain() (0x84b0196e), the three common
 * DOMAIN_SEPARATOR selectors (0x3644e515, 0xf698da25, 0xed24911d) and, for reactors, permit2()
 * (0x12261ee7).
 *
 * Run from the repo root: bun scripts/vectors/order-protocols.ts
 */
import { writeFileSync } from "node:fs";

import { concat, decodeAbiParameters, getAddress, keccak256, toHex } from "viem";

const OUT = "vectors/chains/order-protocols.json";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const RPCS: Record<number, string> = {
  1: "https://ethereum-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  25: "https://cronos-evm-rpc.publicnode.com",
  56: "https://bsc-rpc.publicnode.com",
  100: "https://gnosis-rpc.publicnode.com",
  130: "https://unichain-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com",
  143: "https://rpc.monad.xyz",
  146: "https://sonic-rpc.publicnode.com",
  196: "https://rpc.xlayer.tech",
  324: "https://mainnet.era.zksync.io",
  480: "https://worldchain-mainnet.g.alchemy.com/public",
  999: "https://rpc.hyperliquid.xyz/evm",
  1329: "https://sei-evm-rpc.publicnode.com",
  1672: "https://rpc.pharos.xyz",
  1868: "https://soneium-rpc.publicnode.com",
  4326: "https://mainnet.megaeth.com/rpc",
  5000: "https://mantle-rpc.publicnode.com",
  8453: "https://base-rpc.publicnode.com",
  9745: "https://rpc.plasma.to",
  42161: "https://arbitrum-one-rpc.publicnode.com",
  42220: "https://celo-rpc.publicnode.com",
  43114: "https://avalanche-c-chain-rpc.publicnode.com",
  4663: "https://rpc.chain.robinhood.com",
  5042: "https://rpc.arc.network",
  59144: "https://linea-rpc.publicnode.com",
  8217: "https://public-en.node.kaia.io",
  33139: "https://rpc.apechain.com",
  80094: "https://berachain-rpc.publicnode.com",
  57073: "https://rpc-gel.inkonchain.com",
  747474: "https://rpc.katana.network",
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
  7777777: "https://rpc.zora.energy",
};

/* label, chainId, address, reactor — the deployment map the generator itself verifies on-chain
   and writes to vectors/chains/order-protocols.json. */
const TARGETS: ReadonlyArray<{
  readonly label: string;
  readonly chainId: number;
  readonly address: string;
  readonly reactor: boolean;
}> = [
  {
    label: "1inch-lop-v2-1",
    chainId: 1,
    address: "0x119c71D3BbAC22029622cbaEc24854d3D32D2828",
    reactor: false,
  },
  {
    label: "1inch-lop-v2-10",
    chainId: 10,
    address: "0x11431a89893025D2a48dCA4EddC396f8C8117187",
    reactor: false,
  },
  {
    label: "1inch-lop-v2-137",
    chainId: 137,
    address: "0x94Bc2a1C732BcAd7343B25af48385Fe76E08734f",
    reactor: false,
  },
  {
    label: "1inch-lop-v2-42161",
    chainId: 42161,
    address: "0x7F069df72b7A39bCE9806e3AfaF579E54D8CF2b9",
    reactor: false,
  },
  {
    label: "1inch-lop-v2-56",
    chainId: 56,
    address: "0x1e38Eff998DF9d3669E32f4ff400031385Bf6362",
    reactor: false,
  },
  {
    label: "1inch-v5",
    chainId: 1,
    address: "0x1111111254EEB25477B68fb85Ed929f73A960582",
    reactor: false,
  },
  {
    label: "1inch-v5",
    chainId: 10,
    address: "0x1111111254EEB25477B68fb85Ed929f73A960582",
    reactor: false,
  },
  {
    label: "1inch-v5",
    chainId: 56,
    address: "0x1111111254EEB25477B68fb85Ed929f73A960582",
    reactor: false,
  },
  {
    label: "1inch-v5",
    chainId: 100,
    address: "0x1111111254EEB25477B68fb85Ed929f73A960582",
    reactor: false,
  },
  {
    label: "1inch-v5",
    chainId: 137,
    address: "0x1111111254EEB25477B68fb85Ed929f73A960582",
    reactor: false,
  },
  {
    label: "1inch-v5",
    chainId: 8217,
    address: "0x1111111254EEB25477B68fb85Ed929f73A960582",
    reactor: false,
  },
  {
    label: "1inch-v5",
    chainId: 8453,
    address: "0x1111111254EEB25477B68fb85Ed929f73A960582",
    reactor: false,
  },
  {
    label: "1inch-v5",
    chainId: 42161,
    address: "0x1111111254EEB25477B68fb85Ed929f73A960582",
    reactor: false,
  },
  {
    label: "1inch-v5",
    chainId: 43114,
    address: "0x1111111254EEB25477B68fb85Ed929f73A960582",
    reactor: false,
  },
  {
    label: "1inch-v6",
    chainId: 1,
    address: "0x111111125421cA6dc452d289314280a0f8842A65",
    reactor: false,
  },
  {
    label: "1inch-v6",
    chainId: 10,
    address: "0x111111125421cA6dc452d289314280a0f8842A65",
    reactor: false,
  },
  {
    label: "1inch-v6",
    chainId: 25,
    address: "0x111111125421cA6dc452d289314280a0f8842A65",
    reactor: false,
  },
  {
    label: "1inch-v6",
    chainId: 56,
    address: "0x111111125421cA6dc452d289314280a0f8842A65",
    reactor: false,
  },
  {
    label: "1inch-v6",
    chainId: 100,
    address: "0x111111125421cA6dc452d289314280a0f8842A65",
    reactor: false,
  },
  {
    label: "1inch-v6",
    chainId: 130,
    address: "0x111111125421cA6dc452d289314280a0f8842A65",
    reactor: false,
  },
  {
    label: "1inch-v6",
    chainId: 137,
    address: "0x111111125421cA6dc452d289314280a0f8842A65",
    reactor: false,
  },
  {
    label: "1inch-v6",
    chainId: 143,
    address: "0x111111125421cA6dc452d289314280a0f8842A65",
    reactor: false,
  },
  {
    label: "1inch-v6",
    chainId: 146,
    address: "0x111111125421cA6dc452d289314280a0f8842A65",
    reactor: false,
  },
  {
    label: "1inch-v6",
    chainId: 8217,
    address: "0x111111125421cA6dc452d289314280a0f8842A65",
    reactor: false,
  },
  {
    label: "1inch-v6",
    chainId: 8453,
    address: "0x111111125421cA6dc452d289314280a0f8842A65",
    reactor: false,
  },
  {
    label: "1inch-v6",
    chainId: 42161,
    address: "0x111111125421cA6dc452d289314280a0f8842A65",
    reactor: false,
  },
  {
    label: "1inch-v6",
    chainId: 43114,
    address: "0x111111125421cA6dc452d289314280a0f8842A65",
    reactor: false,
  },
  {
    label: "1inch-v6",
    chainId: 59144,
    address: "0x111111125421cA6dc452d289314280a0f8842A65",
    reactor: false,
  },
  {
    label: "1inch-v6-zksync",
    chainId: 324,
    address: "0x6fd4383cB451173D5f9304F041C7BCBf27d561fF",
    reactor: false,
  },
  {
    label: "augustus-rfq-1",
    chainId: 1,
    address: "0xe92b586627ccA7a83dC919cc7127196d70f55a06",
    reactor: false,
  },
  {
    label: "augustus-rfq-bsc",
    chainId: 56,
    address: "0x8DcDfe88EF0351f27437284D0710cD65b20288bb",
    reactor: false,
  },
  {
    label: "augustus-rfq-op-arb",
    chainId: 10,
    address: "0x0927FD43a7a87E3E8b81Df2c44B03C4756849F6D",
    reactor: false,
  },
  {
    label: "augustus-rfq-op-arb",
    chainId: 42161,
    address: "0x0927FD43a7a87E3E8b81Df2c44B03C4756849F6D",
    reactor: false,
  },
  {
    label: "augustus-rfq-polygon",
    chainId: 137,
    address: "0xF3CD476C3C4D3Ac5cA2724767f269070CA09A043",
    reactor: false,
  },
  {
    label: "bebop-jam",
    chainId: 1,
    address: "0xbEbEbEb035351f58602E0C1C8B59ECBfF5d5f47b",
    reactor: false,
  },
  {
    label: "bebop-jam",
    chainId: 10,
    address: "0xbEbEbEb035351f58602E0C1C8B59ECBfF5d5f47b",
    reactor: false,
  },
  {
    label: "bebop-jam",
    chainId: 56,
    address: "0xbEbEbEb035351f58602E0C1C8B59ECBfF5d5f47b",
    reactor: false,
  },
  {
    label: "bebop-jam",
    chainId: 137,
    address: "0xbEbEbEb035351f58602E0C1C8B59ECBfF5d5f47b",
    reactor: false,
  },
  {
    label: "bebop-jam",
    chainId: 8453,
    address: "0xbEbEbEb035351f58602E0C1C8B59ECBfF5d5f47b",
    reactor: false,
  },
  {
    label: "bebop-jam",
    chainId: 42161,
    address: "0xbEbEbEb035351f58602E0C1C8B59ECBfF5d5f47b",
    reactor: false,
  },
  {
    label: "bebop-jam",
    chainId: 43114,
    address: "0xbEbEbEb035351f58602E0C1C8B59ECBfF5d5f47b",
    reactor: false,
  },
  {
    label: "bebop-settlement",
    chainId: 1,
    address: "0xbbbbbBB520d69a9775E85b458C58c648259FAD5F",
    reactor: false,
  },
  {
    label: "bebop-settlement",
    chainId: 10,
    address: "0xbbbbbBB520d69a9775E85b458C58c648259FAD5F",
    reactor: false,
  },
  {
    label: "bebop-settlement",
    chainId: 56,
    address: "0xbbbbbBB520d69a9775E85b458C58c648259FAD5F",
    reactor: false,
  },
  {
    label: "bebop-settlement",
    chainId: 137,
    address: "0xbbbbbBB520d69a9775E85b458C58c648259FAD5F",
    reactor: false,
  },
  {
    label: "bebop-settlement",
    chainId: 999,
    address: "0xbbbbbBB520d69a9775E85b458C58c648259FAD5F",
    reactor: false,
  },
  {
    label: "bebop-settlement",
    chainId: 8453,
    address: "0xbbbbbBB520d69a9775E85b458C58c648259FAD5F",
    reactor: false,
  },
  {
    label: "bebop-settlement",
    chainId: 42161,
    address: "0xbbbbbBB520d69a9775E85b458C58c648259FAD5F",
    reactor: false,
  },
  {
    label: "bebop-settlement",
    chainId: 43114,
    address: "0xbbbbbBB520d69a9775E85b458C58c648259FAD5F",
    reactor: false,
  },
  {
    label: "bebop-settlement",
    chainId: 80094,
    address: "0xbbbbbBB520d69a9775E85b458C58c648259FAD5F",
    reactor: false,
  },
  {
    label: "blend",
    chainId: 1,
    address: "0x29469395eAf6f95920E59F858042f0e28D98a20B",
    reactor: false,
  },
  {
    label: "blur-v1",
    chainId: 1,
    address: "0x000000000000Ad05Ccc4F10045630fb830B95127",
    reactor: false,
  },
  {
    label: "blur-v2",
    chainId: 1,
    address: "0xb2ecfE4E4D61f8790bbb9DE2D1259B9e2410CEA5",
    reactor: false,
  },
  {
    label: "cow-settlement",
    chainId: 1,
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    reactor: false,
  },
  {
    label: "cow-settlement",
    chainId: 10,
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    reactor: false,
  },
  {
    label: "cow-settlement",
    chainId: 56,
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    reactor: false,
  },
  {
    label: "cow-settlement",
    chainId: 100,
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    reactor: false,
  },
  {
    label: "cow-settlement",
    chainId: 130,
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    reactor: false,
  },
  {
    label: "cow-settlement",
    chainId: 137,
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    reactor: false,
  },
  {
    label: "cow-settlement",
    chainId: 143,
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    reactor: false,
  },
  {
    label: "cow-settlement",
    chainId: 5000,
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    reactor: false,
  },
  {
    label: "cow-settlement",
    chainId: 8453,
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    reactor: false,
  },
  {
    label: "cow-settlement",
    chainId: 9745,
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    reactor: false,
  },
  {
    label: "cow-settlement",
    chainId: 42161,
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    reactor: false,
  },
  {
    label: "cow-settlement",
    chainId: 43114,
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    reactor: false,
  },
  {
    label: "cow-settlement",
    chainId: 59144,
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    reactor: false,
  },
  {
    label: "farcaster-key-gateway",
    chainId: 10,
    address: "0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B",
    reactor: false,
  },
  {
    label: "farcaster-key-request-validator",
    chainId: 10,
    address: "0x00000000FC700472606ED4fA22623Acf62c60553",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 1,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 10,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 25,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 56,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 130,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 137,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 143,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 146,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 196,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 999,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 4326,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 5000,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 8453,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 9745,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 42161,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 43114,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 59144,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-dslo",
    chainId: 80094,
    address: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
    reactor: false,
  },
  {
    label: "kyber-lo",
    chainId: 1,
    address: "0x227B0c196eA8db17A665EA6824D972A64202E936",
    reactor: false,
  },
  {
    label: "kyber-lo",
    chainId: 10,
    address: "0x227B0c196eA8db17A665EA6824D972A64202E936",
    reactor: false,
  },
  {
    label: "kyber-lo",
    chainId: 25,
    address: "0x227B0c196eA8db17A665EA6824D972A64202E936",
    reactor: false,
  },
  {
    label: "kyber-lo",
    chainId: 56,
    address: "0x227B0c196eA8db17A665EA6824D972A64202E936",
    reactor: false,
  },
  {
    label: "kyber-lo",
    chainId: 137,
    address: "0x227B0c196eA8db17A665EA6824D972A64202E936",
    reactor: false,
  },
  {
    label: "kyber-lo",
    chainId: 42161,
    address: "0x227B0c196eA8db17A665EA6824D972A64202E936",
    reactor: false,
  },
  {
    label: "kyber-lo",
    chainId: 43114,
    address: "0x227B0c196eA8db17A665EA6824D972A64202E936",
    reactor: false,
  },
  {
    label: "looksrare-v2",
    chainId: 1,
    address: "0x0000000000E655fAe4d56241588680F86E3b2377",
    reactor: false,
  },
  {
    label: "odos-lo-1",
    chainId: 1,
    address: "0x5F79636fa7bc622eA48802E6cf80A5dae814daE1",
    reactor: false,
  },
  {
    label: "odos-lo-10",
    chainId: 10,
    address: "0xcbF3822A63B7867cD602317fB4aE3ca864826ef8",
    reactor: false,
  },
  {
    label: "odos-lo-137",
    chainId: 137,
    address: "0x93052961c75c92Fd5d6362655936C239EF2D5336",
    reactor: false,
  },
  {
    label: "odos-lo-146",
    chainId: 146,
    address: "0xB9CBD870916e9Ffc52076Caa714f85a022B7f330",
    reactor: false,
  },
  {
    label: "odos-lo-324",
    chainId: 324,
    address: "0x74ab8c1247aE3C5FFFD9F85781F31751bdd98E73",
    reactor: false,
  },
  {
    label: "odos-lo-42161",
    chainId: 42161,
    address: "0x7432657cDda02226ac2aAc9d8f552Ee9613B064e",
    reactor: false,
  },
  {
    label: "odos-lo-43114",
    chainId: 43114,
    address: "0xcc0126349d1bD892D1C53381E68dBF0c8F0E045e",
    reactor: false,
  },
  {
    label: "odos-lo-5000",
    chainId: 5000,
    address: "0xa05A88037402d869b7CA69F5bEc098E19BeDaFbB",
    reactor: false,
  },
  {
    label: "odos-lo-56",
    chainId: 56,
    address: "0x0D4aB12E62D17f037D43F018Da18FF623e1AF3B2",
    reactor: false,
  },
  {
    label: "odos-lo-59144",
    chainId: 59144,
    address: "0xb3a9B56056a5c93F468dF62579b9A5BEa1741069",
    reactor: false,
  },
  {
    label: "odos-lo-8453",
    chainId: 8453,
    address: "0xeDeAfdEf0901eF74Ee28c207BE8424D3B353D97A",
    reactor: false,
  },
  {
    label: "oo-1",
    chainId: 1,
    address: "0xcC8d695603ce0b43D352891892FcC716c6a7C9f4",
    reactor: false,
  },
  {
    label: "oo-1329",
    chainId: 1329,
    address: "0xfE9a934A8607EF020aDf22D4431d6cE6005Aa4d3",
    reactor: false,
  },
  {
    label: "oo-137",
    chainId: 137,
    address: "0xFA9B584Bc9543B66BeFdc41fb1DA8636edD7a697",
    reactor: false,
  },
  {
    label: "oo-146",
    chainId: 146,
    address: "0xB45373129B4220160b92bd2320869f44d48eCd01",
    reactor: false,
  },
  {
    label: "oo-324",
    chainId: 324,
    address: "0x6a9115a77598cb9897347a6c31E6a164Ea06F870",
    reactor: false,
  },
  {
    label: "oo-42161",
    chainId: 42161,
    address: "0x23C78B3d85b45BfA6DC8e09b517ba2d9b0ECCA8C",
    reactor: false,
  },
  {
    label: "oo-43114",
    chainId: 43114,
    address: "0x99b3488Ee3432bB60256140b4BD2488E3b6A705f",
    reactor: false,
  },
  {
    label: "oo-56",
    chainId: 56,
    address: "0xA8A0213bb2ce671E457Ec14D08EB9d40E6DA8e2d",
    reactor: false,
  },
  {
    label: "oo-59144",
    chainId: 59144,
    address: "0x4045734fe21c7B7E0cE516BE009780Cc2BA39A8f",
    reactor: false,
  },
  {
    label: "oo-80094",
    chainId: 80094,
    address: "0x8D2B7e5501Eb6D92F8e349f2FEbe785DD070bE74",
    reactor: false,
  },
  {
    label: "oo-8453",
    chainId: 8453,
    address: "0xb5486f71C902fe0844Bb07221Fa8f47834d90B1b",
    reactor: false,
  },
  {
    label: "oo-c0a6",
    chainId: 10,
    address: "0xc0A62DDCd284020dC883C642A3Ed5D2A1770eb91",
    reactor: false,
  },
  {
    label: "oo-c0a6",
    chainId: 25,
    address: "0xc0A62DDCd284020dC883C642A3Ed5D2A1770eb91",
    reactor: false,
  },
  {
    label: "oo-c0a6",
    chainId: 100,
    address: "0xc0A62DDCd284020dC883C642A3Ed5D2A1770eb91",
    reactor: false,
  },
  {
    label: "uniswapx-exclusive-1",
    chainId: 1,
    address: "0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4",
    reactor: true,
  },
  {
    label: "uniswapx-exclusive-1",
    chainId: 137,
    address: "0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4",
    reactor: true,
  },
  {
    label: "uniswapx-priority-base",
    chainId: 8453,
    address: "0x000000001Ec5656dcdB24D90DFa42742738De729",
    reactor: true,
  },
  {
    label: "uniswapx-v2dutch-1",
    chainId: 1,
    address: "0x00000011F84B9aa48e5f8aA8B9897600006289Be",
    reactor: true,
  },
  {
    label: "uniswapx-v3-arbitrum",
    chainId: 42161,
    address: "0xB274d5F4b833b61B340b654d600A864fB604a87c",
    reactor: true,
  },
  {
    label: "uniswapx-v3-avalanche",
    chainId: 43114,
    address: "0x00000000862cCF095823fc7576Fa6C7e6b7385ef",
    reactor: true,
  },
  {
    label: "uniswapx-v3-base",
    chainId: 8453,
    address: "0x000000008a8330B5d1F43A62Bf4C673A49f27ba0",
    reactor: true,
  },
  {
    label: "uniswapx-v3-bsc",
    chainId: 56,
    address: "0x00000000a55e50C71b70Db3C8B58749cd1E18eB2",
    reactor: true,
  },
  {
    label: "uniswapx-v3-celo",
    chainId: 42220,
    address: "0x00000000B8077fdf2281A80bE96f6c282B5d943A",
    reactor: true,
  },
  {
    label: "uniswapx-v3-monad",
    chainId: 143,
    address: "0x000000000Ac008F7e07210CFb6648e40249232c2",
    reactor: true,
  },
  {
    label: "uniswapx-v3-op",
    chainId: 10,
    address: "0x000000000923439A92daE8930613568824108631",
    reactor: true,
  },
  {
    label: "uniswapx-v3-polygon",
    chainId: 137,
    address: "0x00000000bAB6E234db8AD638B6A6395b7c499Bc4",
    reactor: true,
  },
  {
    label: "uniswapx-v3-unichain-xlayer-soneium",
    chainId: 130,
    address: "0x000000005aF66799D1a6317714D66800f9CA1406",
    reactor: true,
  },
  {
    label: "uniswapx-v3-unichain-xlayer-soneium",
    chainId: 196,
    address: "0x000000005aF66799D1a6317714D66800f9CA1406",
    reactor: true,
  },
  {
    label: "uniswapx-v3-unichain-xlayer-soneium",
    chainId: 1868,
    address: "0x000000005aF66799D1a6317714D66800f9CA1406",
    reactor: true,
  },
  {
    label: "uniswapx-v3-world",
    chainId: 480,
    address: "0x00000000d714EA34028930b762E96bFBe50F42C2",
    reactor: true,
  },
  {
    label: "uniswapx-v3dutch-1",
    chainId: 1,
    address: "0x0000000015757c461808EA25Eb309638B62681cf",
    reactor: true,
  },
  {
    label: "uniswapx-v3dutch-4663",
    chainId: 4663,
    address: "0x000000007A1C8e570011EeDF86A2A35593013cBA",
    reactor: true,
  },
  {
    label: "uniswapx-v3dutch-5042",
    chainId: 5042,
    address: "0x0000000015134054eA82AE0bb9fda66b36402C36",
    reactor: true,
  },
  {
    label: "uniswapx-v3dutch-57073",
    chainId: 57073,
    address: "0x000000007A1C8e570011EeDF86A2A35593013cBA",
    reactor: true,
  },
  {
    label: "uniswapx-v3dutch-7777777",
    chainId: 7777777,
    address: "0x000000002C9A3812e15cf233190992E9a57EDB56",
    reactor: true,
  },
  {
    label: "velora-portikus",
    chainId: 1,
    address: "0x0000000000bbF5c5Fd284e657F01Bd000933C96D",
    reactor: false,
  },
  {
    label: "velora-portikus",
    chainId: 10,
    address: "0x0000000000bbF5c5Fd284e657F01Bd000933C96D",
    reactor: false,
  },
  {
    label: "velora-portikus",
    chainId: 56,
    address: "0x0000000000bbF5c5Fd284e657F01Bd000933C96D",
    reactor: false,
  },
  {
    label: "velora-portikus",
    chainId: 130,
    address: "0x0000000000bbF5c5Fd284e657F01Bd000933C96D",
    reactor: false,
  },
  {
    label: "velora-portikus",
    chainId: 137,
    address: "0x0000000000bbF5c5Fd284e657F01Bd000933C96D",
    reactor: false,
  },
  {
    label: "velora-portikus",
    chainId: 8453,
    address: "0x0000000000bbF5c5Fd284e657F01Bd000933C96D",
    reactor: false,
  },
  {
    label: "velora-portikus",
    chainId: 42161,
    address: "0x0000000000bbF5c5Fd284e657F01Bd000933C96D",
    reactor: false,
  },
  {
    label: "zeroex-v4",
    chainId: 1,
    address: "0xDef1C0ded9bec7F1a1670819833240f027b25EfF",
    reactor: false,
  },
  {
    label: "zeroex-v4",
    chainId: 56,
    address: "0xDef1C0ded9bec7F1a1670819833240f027b25EfF",
    reactor: false,
  },
  {
    label: "zeroex-v4",
    chainId: 137,
    address: "0xDef1C0ded9bec7F1a1670819833240f027b25EfF",
    reactor: false,
  },
  {
    label: "zeroex-v4",
    chainId: 8453,
    address: "0xDef1C0ded9bec7F1a1670819833240f027b25EfF",
    reactor: false,
  },
  {
    label: "zeroex-v4",
    chainId: 42161,
    address: "0xDef1C0ded9bec7F1a1670819833240f027b25EfF",
    reactor: false,
  },
  {
    label: "zeroex-v4",
    chainId: 42220,
    address: "0xDef1C0ded9bec7F1a1670819833240f027b25EfF",
    reactor: false,
  },
  {
    label: "zeroex-v4",
    chainId: 43114,
    address: "0xDef1C0ded9bec7F1a1670819833240f027b25EfF",
    reactor: false,
  },
  {
    label: "zeroex-v4-op",
    chainId: 10,
    address: "0xDEF1ABE32c034e558Cdd535791643C58a13aCC10",
    reactor: false,
  },
];

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

type Probe = {
  readonly label: string;
  readonly chainId: number;
  readonly address: string;
  codePresent: boolean;
  note?: string;
  eip712Domain?: {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
    readonly verifyingContract: string;
  };
  separator?: string;
  separatorFn?: string;
  permit2?: string;
  permit2MatchesCanonical?: boolean;
  owner?: string;
  nonce?: number;
};

const results: Probe[] = [];
for (const target of TARGETS) {
  const url = RPCS[target.chainId];
  const record: Probe = {
    label: target.label,
    chainId: target.chainId,
    address: target.address,
    codePresent: false,
  };
  if (url === undefined) {
    record.note = "no public RPC configured for this chain";
    results.push(record);
    continue;
  }
  const code = await call(url, "eth_getCode", [target.address, "latest"]);
  record.codePresent = typeof code === "string" && code !== "0x";
  if (record.codePresent) {
    const domain = await call(url, "eth_call", [
      { to: target.address, data: "0x84b0196e" },
      "latest",
    ]);
    if (typeof domain === "string" && domain.length > 2) {
      try {
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
        record.eip712Domain = { name, version, chainId: Number(chainId), verifyingContract };
      } catch {
        /* the contract exposes another 0x84b0196e signature */
      }
    }
    for (const [selector, fn] of [
      ["0x3644e515", "DOMAIN_SEPARATOR"],
      ["0xf698da25", "domainSeparator"],
      ["0xed24911d", "_domainSeparatorV4"],
    ] as const) {
      const separator = await call(url, "eth_call", [
        { to: target.address, data: selector },
        "latest",
      ]);
      if (typeof separator === "string" && separator.length === 66) {
        record.separator = separator;
        record.separatorFn = fn;
        break;
      }
    }
    if (target.reactor) {
      const permit2 = await call(url, "eth_call", [
        { to: target.address, data: "0x12261ee7" },
        "latest",
      ]);
      if (typeof permit2 === "string" && permit2.length >= 66) {
        record.permit2 = `0x${permit2.slice(26)}`;
      }
      record.permit2MatchesCanonical = record.permit2 === PERMIT2.toLowerCase();
    }
  }
  results.push(record);
  console.log(
    target.label,
    target.chainId,
    target.address.slice(0, 10),
    record.codePresent ? "code" : "NO CODE",
  );
  await new Promise((resolve) => {
    setTimeout(resolve, 150);
  });
}
/* 0x Deployer `ownerOf(3)` — the MetaTxn-feature Settler on every chain the gasless decoder
   recognises (packages/wallet-chains/src/evm/zerox.ts ZEROX_CHAINS; token id 3 = metatx per
   0xProject/0x-settler@ad7c844 src/deployer/Deployer.sol's feature encoding). The Settler itself
   is not a fixed address — Deployer redeploys it monthly — so the record carries the current
   owner and the feature nonce that derives it via the documented
   `salt = feature<<128 | chainId<<64 | nonce`, CREATE2 shim, CREATE child construction. */
const ZEROX_DEPLOYER = "0x00000000000004533fe15556b1e086bb1a72ceae";
const ZEROX_CHAINS = [1, 10, 56, 137, 8453, 999, 42161, 43114, 11155111] as const;
const SHIM_INIT_CODE_HASH =
  "0x3bf3f97f0be1e2c00023033eefeb4fc062ac552ff36778b17060d90b6764902f" as const;

const zeroxSettler = (chainId: number, feature: bigint, nonce: number): string => {
  const salt = toHex(feature * 2n ** 128n + BigInt(chainId) * 2n ** 64n + BigInt(nonce), {
    size: 32,
  });
  const shim = keccak256(concat(["0xff", ZEROX_DEPLOYER, salt, SHIM_INIT_CODE_HASH]));
  return getAddress(`0x${keccak256(`0xd694${shim.slice(26)}01`).slice(26)}`);
};

for (const chainId of ZEROX_CHAINS) {
  const url = RPCS[chainId];
  const record: Probe = {
    label: "zerox-metatxn",
    chainId,
    address: ZEROX_DEPLOYER,
    codePresent: false,
  };
  if (url === undefined) {
    record.note = "no public RPC configured for this chain";
    results.push(record);
    continue;
  }
  const code = await call(url, "eth_getCode", [ZEROX_DEPLOYER, "latest"]);
  record.codePresent = typeof code === "string" && code !== "0x";
  if (record.codePresent) {
    const owner = await call(url, "eth_call", [
      {
        to: ZEROX_DEPLOYER,
        data: "0x6352211e0000000000000000000000000000000000000000000000000000000000000003",
      },
      "latest",
    ]);
    if (typeof owner === "string" && owner.length >= 66) {
      record.owner = `0x${owner.slice(26)}`;
      for (let nonce = 1; nonce <= 256 && record.nonce === undefined; nonce++) {
        if (zeroxSettler(chainId, 3n, nonce).toLowerCase() === record.owner.toLowerCase()) {
          record.nonce = nonce;
        }
      }
    }
  }
  results.push(record);
  console.log(
    "zerox-metatxn",
    chainId,
    record.owner === undefined ? "NO OWNER" : `owner nonce ${record.nonce ?? "?"}`,
  );
  await new Promise((resolve) => {
    setTimeout(resolve, 150);
  });
}

writeFileSync(OUT, `${JSON.stringify(results, undefined, 2)}\n`);
console.log(`wrote ${results.length} records to ${OUT}`);
