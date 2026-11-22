/* oxlint-disable typescript/no-unsafe-type-assertion -- RPC and JSON oracle payloads are untyped */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

/// <reference types="node" />
// oxlint-disable eslint/no-await-in-loop -- requests are sequential and throttled by design
/**
 * Regenerates vectors/chains/fiat24.json: the Fiat24 calls the EVM decoder describes, the near-miss
 * calls that must stay blind, the raw access-grant texts and the wallet-built evm.fiat24-session
 * requests.
 *
 * Oracles:
 *
 * - The contract ABIs are downloaded at generation time from Sourcify v2
 *   (`https://sourcify.dev/server/v2/contract/42161/<impl>?fields=abi` for the seven pinned
 *   implementation addresses); the file records the URL and keccak256 of the canonical ABI JSON.
 * - Every calldata is built with viem's `encodeFunctionData` (the decoder uses ox) and cross-checked
 *   byte-for-byte against `cast calldata "<signature>" <args>`; generation fails on a mismatch.
 * - The session grant cases re-derive label, digest and signature with `cast keccak`, `cast
 *   hash-message` and `cast wallet sign`, and are asserted equal to the independent
 *
 * @qntx/fiat24 vectors/api/session.json — embedded below so the generator needs no private
 * checkout; the NUL-padded clientPayoutRef calldata is fetched from the chain itself.
 *
 * Every expected prompt is written by hand here — nothing is captured from the decoder.
 *
 * Run from the repo root: bun scripts/vectors/fiat24.ts
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

// The repo does not depend on @types/bun; declare the used surface.
declare const Bun: {
  spawn: (
    cmd: ReadonlyArray<string>,
    opts: { stdout: "pipe"; stderr: "pipe" },
  ) => {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  };
};

const require = createRequire(import.meta.url);
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the CJS require is untyped
const { encodeFunctionData } = require("viem") as {
  encodeFunctionData: (args: {
    abi: unknown;
    functionName: string;
    args: ReadonlyArray<unknown>;
  }) => string;
};

const OUT = "vectors/chains/fiat24.json";
/* Archive endpoints for the on-chain oracle — the same ones the mainnet corpus generator uses. */
const RPCS = ["https://arbitrum.gateway.tenderly.co", "https://arbitrum-one.public.blastapi.io"];
/* The real clientPayoutRef whose reference is NUL-padded — input fetched verbatim from the chain. */
const NUL_REF_TX = "0xbe87afca37b50fc68a3dd9ea5b18c6377b50f7491085f3989c6f04131439dea3";
const CLIENT_PAYOUT_REF_SELECTOR = "0xeb6d2d71";

/* The independent @qntx/fiat24 session oracle rows, embedded verbatim so generation does not
   depend on a developer checkout — @qntx/fiat24 vectors/api/session.json, generated with
   cast 1.10.0 (SDK repo qntx/fiat24, commit b7c2f0f). */
const SESSION_ROWS: ReadonlyArray<{
  args: { chainId: string; tokenId: string; deadline: string };
  label: string;
  preimage: string;
  digest: string;
  message: string;
  eip191Hash: string;
  signature?: string;
}> = [
  {
    args: { chainId: "42161", tokenId: "123456", deadline: "1795278000" },
    label: "fiat24-session-v1:42161:123456:1795278000",
    preimage: "fiat24-session-v1:42161:123456:17952780001795278000",
    digest: "0x7aa5d53d52ac69271847fc6b9385c9080a249f9d3c2aff9f721ca821a8109025",
    message:
      "I agree to access my profile. 0x7aa5d53d52ac69271847fc6b9385c9080a249f9d3c2aff9f721ca821a8109025",
    eip191Hash: "0x42e71571afdd4e74672f74c8bddc84e45a6f637fae50032640edb54588efcdfa",
    signature:
      "0x09410c3f5d15d8022f6baa8e556eeeee446164f864e33c9e6ff30fc63d7c45996719e723721bef79e3daebade7979538306b14039290d25338f19b74fe8cb0031c",
  },
  {
    args: { chainId: "42161", tokenId: "1", deadline: "1795305600" },
    label: "fiat24-session-v1:42161:1:1795305600",
    preimage: "fiat24-session-v1:42161:1:17953056001795305600",
    digest: "0x5d7df61b38b749bb4f56ed475606a771754b12494427b00c7e1df9a200ac2202",
    message:
      "I agree to access my profile. 0x5d7df61b38b749bb4f56ed475606a771754b12494427b00c7e1df9a200ac2202",
    eip191Hash: "0x385c99758dfbd01204bcd980b990c73dd91e5bd25ff07cad5c6a8e5d43eaab64",
  },
  {
    args: { chainId: "42161", tokenId: "9007199254740993", deadline: "4102444800" },
    label: "fiat24-session-v1:42161:9007199254740993:4102444800",
    preimage: "fiat24-session-v1:42161:9007199254740993:41024448004102444800",
    digest: "0x2357270ce0d4f3fa5a9a51eafbf0580ebb8dad931e4008b30ba274e83dacdb2b",
    message:
      "I agree to access my profile. 0x2357270ce0d4f3fa5a9a51eafbf0580ebb8dad931e4008b30ba274e83dacdb2b",
    eip191Hash: "0xe66787ac443bd91d65cc73499568ad74cba295b0790b11315333c8a75b26bc2e",
  },
];

/* Pinned deployment (Sourcify v2, exact match; see evidence SOURCIFY rows). */
const USD24 = "0xbE00f3db78688d9704BCb4e0a827aea3a9Cc0D62";
const EUR24 = "0x2c5d06f591D0d8cd43Ac232c2B654475a142c7DA";
const CHF24 = "0xd41F1f0cf89fD239ca4c1F8E8ADA46345c86b0a4";
const CNH24 = "0x7288Ac74d211735374A23707D1518DCbbc0144fd";
const ACCOUNT = "0x133CAEecA096cA54889db71956c7f75862Ead7A0";
const DEPOSIT = "0x4582f67698843Dfb6A9F195C0dDee05B0A8C973F";
const CARD = "0xe2e3B88B9893e18D0867c08f9cA93f8aB5935b14";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const GMX = "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a";
const OTHER = "0x00000000000000000000000000000000C0FfeE00";
const SIGNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const LOOKALIKE = "0x133CAEecA096cA54889db71956c7f75862Ead7B0";
const IMPL_ACCOUNT = "0x78726B1ea6422fFB3744eACe66b13e22Df0cB54d";

const IMPL = {
  Fiat24Account: "0x78726B1ea6422fFB3744eACe66b13e22Df0cB54d",
  Fiat24USD: "0x98BEC5F54FF3967593860cEBc38F2134F4FF74E1",
  Fiat24EUR: "0x7aFe16b7d1A2F4C106E49FD0C2BE852a3a536E96",
  Fiat24CHF: "0xc022c45FC88824772A265D16A3879753272fCC6b",
  Fiat24CNH: "0xFc1b2f3059cf8a6850983557b097403e9f3a54f6",
  Fiat24CryptoDeposit: "0xEBd98769dE0946e0C803c2e121D55dB6248C616B",
  Fiat24CardAuthorizationMarqeta: "0x96AA3D05755C54D2745d0Dc98Ea55E163DA5Bb16",
} as const;

const sleep = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const run = async (args: ReadonlyArray<string>): Promise<string> => {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${args.join(" ")} failed (${code}): ${err.trim()}`);
  }
  return out.trim();
};

/** `cast calldata` — the independent encoder every viem-built call is checked against. */
const castCalldata = async (signature: string, args: ReadonlyArray<string>): Promise<string> => {
  const out = await run(["cast", "calldata", signature, ...args]);
  return out.toLowerCase();
};

const rpc = async (method: string, params: ReadonlyArray<unknown>): Promise<unknown> => {
  let last: Error | undefined;
  for (const url of RPCS) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const body = (await res.json()) as { result?: unknown; error?: { message: string } };
        if (body.error === undefined) {
          await sleep(300);
          return body.result;
        }
        last = new Error(`${url} ${method}: ${body.error.message}`);
      } catch (error) {
        last = error instanceof Error ? error : new Error(String(error));
      }
      await sleep(800);
    }
  }
  throw last ?? new Error(`${method}: all endpoints failed`);
};

/** Downloads a Sourcify v2 ABI and returns it plus the provenance the file records. */
const fetchAbi = async (
  impl: string,
): Promise<{ abi: ReadonlyArray<Record<string, unknown>>; source: Record<string, string> }> => {
  const url = `https://sourcify.dev/server/v2/contract/42161/${impl}?fields=abi`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`sourcify ${impl}: ${res.status}`);
  }
  const body = (await res.json()) as { abi?: ReadonlyArray<Record<string, unknown>> };
  if (body.abi === undefined) {
    throw new Error(`sourcify ${impl}: no abi field`);
  }
  const canonical = JSON.stringify(body.abi);
  await sleep(200);
  return {
    abi: body.abi,
    source: { url, keccak256: `0x${bytesToHex(keccak_256(utf8ToBytes(canonical)))}` },
  };
};

/**
 * Builds calldata with viem over the Sourcify ABI and fails the run unless `cast calldata` agrees
 * byte-for-byte — two independent encoders must produce identical bytes.
 */
const data = async (
  abi: unknown,
  signature: string,
  name: string,
  args: ReadonlyArray<unknown>,
): Promise<string> => {
  const viem = encodeFunctionData({ abi, functionName: name, args }).toLowerCase();
  const cast = await castCalldata(signature, args.map(String));
  if (viem !== cast) {
    throw new Error(`${name}: viem ${viem} != cast ${cast}`);
  }
  await sleep(50);
  return viem;
};

type Prompt2 = { readonly en: string; readonly "zh-Hans": string };
type Expectation = {
  readonly summary: string;
  readonly verifiability: string;
  readonly blind?: string;
  readonly warnings: ReadonlyArray<string>;
  readonly prompt: Prompt2;
};
type VectorCase = {
  readonly name: string;
  readonly signer: string;
  readonly request: Record<string, unknown>;
  readonly session?: Record<string, string>;
  readonly expect: Expectation;
};

const NET_EN = "Network: Arbitrum One";
const NET_ZH = "网络：Arbitrum One";
const OUT_EN = "There may be other outflows";
const OUT_ZH = "可能还有其他转出";
const FEE_EN = "Max fee 0.000196608 ETH";
const FEE_ZH = "最高手续费 0.000196608 ETH";
const F24FN_EN =
  "The wallet cannot describe this Fiat24 call: an unrecognised function of a Fiat24 contract, or a Fiat24 function sent to another contract or network";
const F24FN_ZH =
  "钱包无法描述此 Fiat24 调用：Fiat24 合约的未识别函数，或发送到其他合约或网络的 Fiat24 函数";
const RATE_EN =
  "Fiat24 sets the rate when the transaction runs; there is no minimum you will receive";
const RATE_ZH = "交易执行时由 Fiat24 设定汇率；没有保证你会收到的最低额度";
const RECV_EN = (sym: string) =>
  `Receive ${sym} at the rate Fiat24 sets when the transaction runs — no minimum`;
const RECV_ZH = (sym: string) => `按交易执行时 Fiat24 设定的汇率收到 ${sym}——没有最低到手额`;
const PAYEE_EN =
  "Fiat24 picks the receiving bank account off-chain from this payee; the wallet cannot verify who receives the payout";
const PAYEE_ZH = "Fiat24 在链下为该收款人选择收款银行账户；钱包无法核实谁收到出金";
const GRANT_EN =
  "This is a Fiat24 account access grant: until it expires, anyone holding the signature can read your profile and card details and change cards, payees and your email. The wallet signs Fiat24 grants only when it builds them itself.";
const GRANT_ZH =
  "这是一条 Fiat24 账户访问授权：过期前，任何持有此签名的人都能读取你的资料和卡信息，并修改卡、收款人和你的邮箱。钱包只对自行构造的授权签名。";
const SES_POWER_EN =
  "Until then, anyone holding this signature can read your Fiat24 profile and contact data, view your card details, create and change cards and payees, and change your email — the channel for card one-time passwords";
const SES_POWER_ZH =
  "在此之前，任何持有此签名的人都能读取你的 Fiat24 资料和联系方式、查看你的卡信息、创建和修改卡与收款人，以及修改你的邮箱——银行卡一次性验证码的送达渠道";

const account = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;

const evmTx = (
  to: string,
  dataHex: string,
  value = "0x0",
  chainId = 42161,
): Record<string, unknown> => ({
  kind: "evm.transaction",
  network: `eip155:${chainId}`,
  account,
  tx: {
    type: "eip1559",
    chainId,
    nonce: 0,
    gas: "0x30000",
    to,
    value,
    data: dataHex,
    accessList: [],
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x1",
  },
});

const txPrompt = (
  titleEn: string,
  titleZh: string,
  enLines: ReadonlyArray<string>,
  zhLines: ReadonlyArray<string>,
  enWarns: ReadonlyArray<string> = [],
  zhWarns: ReadonlyArray<string> = [],
): Prompt2 => ({
  en: [titleEn, NET_EN, OUT_EN, ...enLines, FEE_EN, ...enWarns].join("\n"),
  "zh-Hans": [titleZh, NET_ZH, OUT_ZH, ...zhLines, FEE_ZH, ...zhWarns].join("\n"),
});

const blindPrompt = (to: string, selector: string, chain: "arb" | "eth" = "arb"): Prompt2 => ({
  en: [
    "Confirm blind signing",
    chain === "arb" ? NET_EN : "Network: Ethereum",
    F24FN_EN,
    `Call contract ${to}, function ${selector}`,
    FEE_EN,
  ].join("\n"),
  "zh-Hans": [
    "确认盲签",
    chain === "arb" ? NET_ZH : "网络：Ethereum",
    F24FN_ZH,
    `调用合约 ${to}，函数 ${selector}`,
    FEE_ZH,
  ].join("\n"),
});

const grantPrompt = (text: string): Prompt2 => ({
  en: `Confirm blind signing\n${GRANT_EN}\nMessage:\n· ${text}`,
  "zh-Hans": `确认盲签\n${GRANT_ZH}\n消息：\n· ${text}`,
});

const pad2 = (n: number): string => String(n).padStart(2, "0");
const sessionPrompt = (tokenId: string, deadline: string, message: string): Prompt2 => {
  const d = new Date(Number(deadline) * 1000);
  const pad = pad2;
  const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return {
    en: `Allow Fiat24 account access\n${NET_EN}\nFiat24 account #${tokenId}\nExpires ${stamp} (UTC)\n${SES_POWER_EN}\nSigns: ${message}`,
    "zh-Hans": `授权访问 Fiat24 账户\n${NET_ZH}\nFiat24 账户 #${tokenId}\n${stamp}（UTC）过期\n${SES_POWER_ZH}\n签名消息：${message}`,
  };
};

/** One ABI's overloads narrowed to a single function so viem can encode it. */
const fnAbi = (
  abi: ReadonlyArray<Record<string, unknown>>,
  name: string,
  argCount: number,
): ReadonlyArray<Record<string, unknown>> => {
  const fns = abi.filter(
    (i) =>
      i["type"] === "function" &&
      i["name"] === name &&
      (i["inputs"] as ReadonlyArray<unknown>).length === argCount,
  );
  if (fns.length !== 1) {
    throw new Error(`abi: ${name} x${fns.length} for ${argCount} args`);
  }
  return fns;
};

const call = async (
  abi: ReadonlyArray<Record<string, unknown>>,
  signature: string,
  name: string,
  args: ReadonlyArray<unknown>,
): Promise<string> => data(fnAbi(abi, name, args.length), signature, name, args);

const sendPrompt = (amt: string, sym: string, id: string, warn?: [string, string]) =>
  txPrompt(
    "Confirm transfer",
    "确认转账",
    [`Send ${amt} ${sym} to Fiat24 account #${id} (whoever holds it when the transaction runs)`],
    [`发送 ${amt} ${sym} 到 Fiat24 账户 #${id}（收款人是交易执行时该账户的持有者）`],
    warn === undefined ? [] : [warn[0]],
    warn === undefined ? [] : [warn[1]],
  );
const INTERNAL_EN = (id: string) =>
  `Fiat24 account #${id} is one of the issuer's internal accounts (9100–9299), not a client — this is not a payment to a person`;
const INTERNAL_ZH = (id: string) =>
  `Fiat24 账户 #${id} 是发行方的内部账户（9100–9299），不是客户账户——这不是向个人付款`;

const UNLIM_EN = (role: string) =>
  `Danger: an unlimited allowance lets the Fiat24 ${role} contract take your entire balance of this token`;
const UNLIM_ZH = (role: string) =>
  `危险：无限额度授权允许 Fiat24 ${role}合约转走你此代币的全部余额`;

const main = async () => {
  /* Fetch every implementation ABI from Sourcify v2; each is recorded with its URL and the
     keccak256 of the canonical ABI JSON. */
  const sourcify: Record<string, Record<string, string>> = {};
  const abis: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
  const PROXY_OF: Record<string, string> = {
    Fiat24Account: ACCOUNT,
    Fiat24USD: USD24,
    Fiat24EUR: EUR24,
    Fiat24CHF: CHF24,
    Fiat24CNH: CNH24,
    Fiat24CryptoDeposit: DEPOSIT,
    Fiat24CardAuthorizationMarqeta: CARD,
  };
  for (const [name, impl] of Object.entries(IMPL)) {
    const { abi, source } = await fetchAbi(impl);
    abis[name] = abi;
    sourcify[name] = { proxy: PROXY_OF[name] ?? "", ...source };
  }
  const need = (k: string): ReadonlyArray<Record<string, unknown>> => {
    const abi = abis[k];
    if (abi === undefined) {
      throw new Error(`missing abi ${k}`);
    }
    return abi;
  };
  const USD24_ABI = need("Fiat24USD");
  const EUR24_ABI = need("Fiat24EUR");
  const CHF24_ABI = need("Fiat24CHF");
  const CNH24_ABI = need("Fiat24CNH");
  const ACCOUNT_ABI = need("Fiat24Account");
  const DEPOSIT_ABI = need("Fiat24CryptoDeposit");

  /* The real clientPayoutRef with a NUL-padded reference — tx 0xbe87…dea3 on Arbitrum One, its
     calldata fetched from the chain itself and asserted to be a payout-ref call to EUR24. */
  const payoutTx = (await rpc("eth_getTransactionByHash", [NUL_REF_TX])) as {
    to?: string;
    input?: string;
  };
  if ((payoutTx.to ?? "").toLowerCase() !== EUR24.toLowerCase()) {
    throw new Error(`NUL-ref tx targets ${payoutTx.to ?? "?"}; expected the EUR24 proxy`);
  }
  const NUL_REF_DATA = (payoutTx.input ?? "").toLowerCase();
  if (!NUL_REF_DATA.startsWith(CLIENT_PAYOUT_REF_SELECTOR)) {
    throw new Error(`NUL-ref tx input selector ${NUL_REF_DATA.slice(0, 10)} != clientPayoutRef`);
  }

  const cases: VectorCase[] = [];
  const add = (c: VectorCase) => {
    cases.push(c);
  };

  /* transferByAccountId on all four cash tokens; the EUR24 case addresses an issuer-internal
     account and carries the internal-account warning. */
  for (const [name, token, abi, sym, id, amount, pretty] of [
    ["transferByAccountId-usd24", USD24, USD24_ABI, "USD24", "10365", 20000n, "200"],
    ["transferByAccountId-chf24", CHF24, CHF24_ABI, "CHF24", "2050", 50050n, "500.5"],
    ["transferByAccountId-cnh24", CNH24, CNH24_ABI, "CNH24", "999999", 88n, "0.88"],
  ] as const) {
    add({
      name,
      signer: SIGNER,
      request: evmTx(
        token,
        await call(abi, "transferByAccountId(uint256,uint256)", "transferByAccountId", [
          BigInt(id),
          amount,
        ]),
      ),
      expect: {
        summary: "transfer",
        verifiability: "partial",
        warnings: [],
        prompt: sendPrompt(pretty, sym, id),
      },
    });
  }
  add({
    name: "transferByAccountId-eur24-internal",
    signer: SIGNER,
    request: evmTx(
      EUR24,
      await call(EUR24_ABI, "transferByAccountId(uint256,uint256)", "transferByAccountId", [
        9102n,
        100n,
      ]),
    ),
    expect: {
      summary: "transfer",
      verifiability: "partial",
      warnings: ["fiat24-internal-account"],
      prompt: sendPrompt("1", "EUR24", "9102", [INTERNAL_EN("9102"), INTERNAL_ZH("9102")]),
    },
  });

  /* Bank payouts. */
  const PAYEE_WARN: [ReadonlyArray<string>, ReadonlyArray<string>] = [[PAYEE_EN], [PAYEE_ZH]];
  add({
    name: "clientPayout",
    signer: SIGNER,
    request: evmTx(
      CHF24,
      await call(CHF24_ABI, "clientPayout(uint256,string)", "clientPayout", [10055n, "EA-0000001"]),
    ),
    expect: {
      summary: "payout",
      verifiability: "partial",
      warnings: ["fiat24-payee-offchain"],
      prompt: txPrompt(
        "Confirm payout",
        "确认出金",
        ["Pay out 100.55 CHF24 by bank transfer to a Fiat24 payee", "· Fiat24 payee EA-0000001"],
        ["以银行转账出金 100.55 CHF24 给 Fiat24 收款人", "· Fiat24 收款人 EA-0000001"],
        PAYEE_WARN[0],
        PAYEE_WARN[1],
      ),
    },
  });
  add({
    name: "clientPayoutRef",
    signer: SIGNER,
    request: evmTx(
      EUR24,
      await call(EUR24_ABI, "clientPayoutRef(uint256,string,uint256,string)", "clientPayoutRef", [
        1000n,
        "EA-0000002",
        42n,
        "INV-0001",
      ]),
    ),
    expect: {
      summary: "payout",
      verifiability: "partial",
      warnings: ["fiat24-payee-offchain"],
      prompt: txPrompt(
        "Confirm payout",
        "确认出金",
        [
          "Pay out 10 EUR24 by bank transfer to a Fiat24 payee",
          "· Fiat24 payee EA-0000002",
          "· Purpose 42",
          "· Fiat24 reference INV-0001",
        ],
        [
          "以银行转账出金 10 EUR24 给 Fiat24 收款人",
          "· Fiat24 收款人 EA-0000002",
          "· 用途 42",
          "· Fiat24 参考 INV-0001",
        ],
        PAYEE_WARN[0],
        PAYEE_WARN[1],
      ),
    },
  });
  /* The NUL-padded reference of tx 0xbe87…dea3: bytes taken verbatim from the recorded call
     vector; viem is asserted to reproduce them — cast cannot take NULs in argv. */
  const nulVi = encodeFunctionData({
    abi: fnAbi(EUR24_ABI, "clientPayoutRef", 4),
    functionName: "clientPayoutRef",
    args: [4129n, "EA-00001156", 8n, "690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3\u0000\u0000"],
  }).toLowerCase();
  if (nulVi !== NUL_REF_DATA) {
    throw new Error(`clientPayoutRef NUL: viem ${nulVi} != recorded ${NUL_REF_DATA}`);
  }
  add({
    name: "clientPayoutRef-nul",
    signer: SIGNER,
    request: evmTx(EUR24, NUL_REF_DATA),
    expect: {
      summary: "payout",
      verifiability: "partial",
      warnings: ["fiat24-payee-offchain"],
      prompt: txPrompt(
        "Confirm payout",
        "确认出金",
        [
          "Pay out 41.29 EUR24 by bank transfer to a Fiat24 payee",
          "· Fiat24 payee EA-00001156",
          "· Purpose 8",
          "· Fiat24 reference 690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3��",
        ],
        [
          "以银行转账出金 41.29 EUR24 给 Fiat24 收款人",
          "· Fiat24 收款人 EA-00001156",
          "· 用途 8",
          "· Fiat24 参考 690333-50fb0941-4f59-4a89-8735-dd78ba7d53a3��",
        ],
        PAYEE_WARN[0],
        PAYEE_WARN[1],
      ),
    },
  });

  /* FX — both directions. */
  add({
    name: "moneyExchangeExactIn",
    signer: SIGNER,
    request: evmTx(
      DEPOSIT,
      await call(
        DEPOSIT_ABI,
        "moneyExchangeExactIn(address,address,uint256)",
        "moneyExchangeExactIn",
        [USD24, EUR24, 1000n],
      ),
    ),
    expect: {
      summary: "swap",
      verifiability: "partial",
      warnings: ["fiat24-issuer-rate"],
      prompt: txPrompt(
        "Confirm swap",
        "确认兑换",
        [`Send 10 USD24 to ${DEPOSIT}`, RECV_EN("EUR24")],
        [`发送 10 USD24 到 ${DEPOSIT}`, RECV_ZH("EUR24")],
        [RATE_EN],
        [RATE_ZH],
      ),
    },
  });
  add({
    name: "moneyExchangeExactOut",
    signer: SIGNER,
    request: evmTx(
      DEPOSIT,
      await call(
        DEPOSIT_ABI,
        "moneyExchangeExactOut(address,address,uint256)",
        "moneyExchangeExactOut",
        [USD24, EUR24, 1000n],
      ),
    ),
    expect: {
      summary: "swap",
      verifiability: "partial",
      warnings: ["fiat24-issuer-rate", "fiat24-exact-out-unbounded"],
      prompt: txPrompt(
        "Confirm swap",
        "确认兑换",
        ["Receive 10 EUR24; pay USD24 at the rate Fiat24 sets"],
        ["收到 10 EUR24；按 Fiat24 设定的汇率支付 USD24"],
        [
          RATE_EN,
          "What you pay is bounded only by your allowance for the Fiat24 top-up and exchange contract",
        ],
        [RATE_ZH, "你的支付仅以你对 Fiat24 充值与兑换合约的授权额度为上限"],
      ),
    },
  });

  /* The three top-ups; only non-USDC inputs carry the swap-quote warning. */
  const QUOTE_EN =
    "The swap to USDC is priced inside the transaction itself; you set no slippage limit";
  const QUOTE_ZH = "到 USDC 的兑换在交易内部定价；你没有设置滑点上限";
  add({
    name: "depositTokenViaUsdc",
    signer: SIGNER,
    request: evmTx(
      DEPOSIT,
      await call(
        DEPOSIT_ABI,
        "depositTokenViaUsdc(address,address,uint256)",
        "depositTokenViaUsdc",
        [USDC, EUR24, 5000000n],
      ),
    ),
    expect: {
      summary: "swap",
      verifiability: "partial",
      warnings: ["fiat24-issuer-rate"],
      prompt: txPrompt(
        "Confirm swap",
        "确认兑换",
        [`Send 5 USDC to ${DEPOSIT}`, RECV_EN("EUR24")],
        [`发送 5 USDC 到 ${DEPOSIT}`, RECV_ZH("EUR24")],
        [RATE_EN],
        [RATE_ZH],
      ),
    },
  });
  add({
    name: "depositETH",
    signer: SIGNER,
    request: evmTx(
      DEPOSIT,
      await call(DEPOSIT_ABI, "depositETH(address)", "depositETH", [EUR24]),
      "0xaa87bee538000",
    ),
    expect: {
      summary: "swap",
      verifiability: "partial",
      warnings: ["fiat24-issuer-rate", "fiat24-swap-quote"],
      prompt: txPrompt(
        "Confirm swap",
        "确认兑换",
        [`Send 0.003 ETH to ${DEPOSIT}`, RECV_EN("EUR24")],
        [`发送 0.003 ETH 到 ${DEPOSIT}`, RECV_ZH("EUR24")],
        [RATE_EN, QUOTE_EN],
        [RATE_ZH, QUOTE_ZH],
      ),
    },
  });
  add({
    name: "depositTokenViaEth",
    signer: SIGNER,
    request: evmTx(
      DEPOSIT,
      await call(DEPOSIT_ABI, "depositTokenViaEth(address,address,uint256)", "depositTokenViaEth", [
        GMX,
        EUR24,
        1000000000000000000n,
      ]),
    ),
    expect: {
      summary: "swap",
      verifiability: "partial",
      warnings: ["fiat24-issuer-rate", "fiat24-swap-quote"],
      prompt: txPrompt(
        "Confirm swap",
        "确认兑换",
        [
          `Send 1000000000000000000 base units of unverified token ${GMX} to ${DEPOSIT}`,
          RECV_EN("EUR24"),
        ],
        [
          `发送 1000000000000000000 个最小单位（未验证代币 ${GMX}） 到 ${DEPOSIT}`,
          RECV_ZH("EUR24"),
        ],
        [RATE_EN, QUOTE_EN],
        [RATE_ZH, QUOTE_ZH],
      ),
    },
  });

  /* Opening an account — with and without the ETH price. */
  const LINK_EN =
    "Opening the account permanently links this address to the identity you verify with Fiat24";
  const LINK_ZH = "开通账户会将此地址与你向 Fiat24 验证的身份永久关联";
  add({
    name: "mintByClient",
    signer: SIGNER,
    request: evmTx(
      ACCOUNT,
      await call(ACCOUNT_ABI, "mintByClient(uint256)", "mintByClient", [123456n]),
    ),
    expect: {
      summary: "contract-call",
      verifiability: "partial",
      warnings: ["fiat24-account-link"],
      prompt: txPrompt(
        "Confirm contract call",
        "确认合约调用",
        ["Open Fiat24 account #123456 for this address"],
        ["为此地址开通 Fiat24 账户 #123456"],
        [LINK_EN],
        [LINK_ZH],
      ),
    },
  });
  add({
    name: "mintByClientWithETH",
    signer: SIGNER,
    request: evmTx(
      ACCOUNT,
      await call(ACCOUNT_ABI, "mintByClientWithETH(uint256)", "mintByClientWithETH", [123456n]),
      "0x38d7ea4c68000",
    ),
    expect: {
      summary: "contract-call",
      verifiability: "partial",
      warnings: ["fiat24-account-link"],
      prompt: txPrompt(
        "Confirm contract call",
        "确认合约调用",
        [`Send 0.001 ETH to ${ACCOUNT}`, "Open Fiat24 account #123456 for this address"],
        [`发送 0.001 ETH 到 ${ACCOUNT}`, "为此地址开通 Fiat24 账户 #123456"],
        [LINK_EN],
        [LINK_ZH],
      ),
    },
  });

  /* Moving the account NFT moves the money and the verified identity. */
  const nftPrompt = () =>
    txPrompt(
      "Confirm transfer",
      "确认转账",
      [`Send ${ACCOUNT} #123456 to ${OTHER}`],
      [`发送 ${ACCOUNT} #123456 到 ${OTHER}`],
      [
        `Danger: this moves control of Fiat24 account #123456 → ${OTHER} — its money and the identity verified for it`,
      ],
      [`危险：这将转移 Fiat24 账户 #123456 → ${OTHER} 的控制权——包括其中的资金与已验证身份`],
    );
  for (const [name, sig, args, argCount] of [
    [
      "accountTransferFrom",
      "transferFrom(address,address,uint256)",
      [SIGNER, OTHER, 123456n] as ReadonlyArray<unknown>,
      3,
    ],
    [
      "accountSafeTransferFrom",
      "safeTransferFrom(address,address,uint256)",
      [SIGNER, OTHER, 123456n] as ReadonlyArray<unknown>,
      3,
    ],
    [
      "accountSafeTransferFrom-data",
      "safeTransferFrom(address,address,uint256,bytes)",
      [SIGNER, OTHER, 123456n, "0x1234"] as ReadonlyArray<unknown>,
      4,
    ],
  ] as const) {
    add({
      name,
      signer: SIGNER,
      request: evmTx(
        ACCOUNT,
        await call(
          fnAbi(ACCOUNT_ABI, sig.split("(")[0] ?? "", argCount),
          sig,
          sig.split("(")[0] ?? "",
          args,
        ),
      ),
      expect: {
        summary: "transfer",
        verifiability: "partial",
        warnings: ["fiat24-account-move"],
        prompt: nftPrompt(),
      },
    });
  }

  /* Approvals to the Fiat24 card and deposit contracts. */
  const CARD_PULL_EN =
    "The Fiat24 card contract can take up to this allowance at any time, without asking you, whenever the issuer authorises a card payment";
  const CARD_PULL_ZH = "Fiat24 卡合约可以在发行方授权卡支付时随时按此额度扣款，无需再询问你";
  const approvePrompt = (line: [string, string], warns: ReadonlyArray<readonly [string, string]>) =>
    txPrompt(
      "Confirm approval",
      "确认授权",
      [line[0]],
      [line[1]],
      warns.map((w) => w[0]),
      warns.map((w) => w[1]),
    );
  add({
    name: "approve-card",
    signer: SIGNER,
    request: evmTx(
      EUR24,
      await call(EUR24_ABI, "approve(address,uint256)", "approve", [CARD, 500000n]),
    ),
    expect: {
      summary: "approve",
      verifiability: "partial",
      warnings: ["fiat24-card-pull"],
      prompt: approvePrompt(
        [
          `Allow ${CARD} to spend 5000 EUR24 (Fiat24 card)`,
          `授权 ${CARD} 使用 5000 EUR24（Fiat24 卡）`,
        ],
        [[CARD_PULL_EN, CARD_PULL_ZH]],
      ),
    },
  });
  add({
    name: "approve-card-unlimited",
    signer: SIGNER,
    request: evmTx(
      USD24,
      await call(USD24_ABI, "approve(address,uint256)", "approve", [
        CARD,
        "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      ]),
    ),
    expect: {
      summary: "approve",
      verifiability: "partial",
      warnings: ["fiat24-card-pull", "fiat24-unlimited-approval"],
      prompt: approvePrompt(
        [
          `Allow ${CARD} to spend unlimited USD24 (Fiat24 card)`,
          `授权 ${CARD} 使用 全部 USD24（Fiat24 卡）`,
        ],
        [
          [CARD_PULL_EN, CARD_PULL_ZH],
          [UNLIM_EN("card"), UNLIM_ZH("卡")],
        ],
      ),
    },
  });
  add({
    name: "approve-card-zero",
    signer: SIGNER,
    request: evmTx(USD24, await call(USD24_ABI, "approve(address,uint256)", "approve", [CARD, 0n])),
    expect: {
      summary: "approve",
      verifiability: "partial",
      warnings: [],
      prompt: approvePrompt(
        [
          `Revoke ${CARD}'s allowance for USD24 (Fiat24 card)`,
          `撤销 ${CARD} 对 USD24 的授权（Fiat24 卡）`,
        ],
        [],
      ),
    },
  });
  add({
    name: "approve-deposit",
    signer: SIGNER,
    request: evmTx(
      USD24,
      await call(USD24_ABI, "approve(address,uint256)", "approve", [DEPOSIT, 100000n]),
    ),
    expect: {
      summary: "approve",
      verifiability: "partial",
      warnings: [],
      prompt: approvePrompt(
        [
          `Allow ${DEPOSIT} to spend 1000 USD24 (Fiat24 top-up and exchange)`,
          `授权 ${DEPOSIT} 使用 1000 USD24（Fiat24 充值与兑换）`,
        ],
        [],
      ),
    },
  });
  add({
    name: "increaseAllowance-card",
    signer: SIGNER,
    request: evmTx(
      CHF24,
      await call(CHF24_ABI, "increaseAllowance(address,uint256)", "increaseAllowance", [
        CARD,
        100000n,
      ]),
    ),
    expect: {
      summary: "approve",
      verifiability: "partial",
      warnings: ["fiat24-card-pull"],
      prompt: approvePrompt(
        [
          `Allow ${CARD} to spend 1000 CHF24 more (Fiat24 card)`,
          `授权 ${CARD} 再使用 1000 CHF24（Fiat24 卡）`,
        ],
        [[CARD_PULL_EN, CARD_PULL_ZH]],
      ),
    },
  });

  /* Blind near misses — claimed by the Fiat24 family but not describable. */
  const BLIND_SEL = "0xdeadbeef";
  for (const [name, to] of [
    ["unknownSelector-usd24", USD24],
    ["unknownSelector-eur24", EUR24],
    ["unknownSelector-chf24", CHF24],
    ["unknownSelector-cnh24", CNH24],
    ["unknownSelector-account", ACCOUNT],
    ["unknownSelector-deposit", DEPOSIT],
    ["unknownSelector-card", CARD],
  ] as const) {
    add({
      name,
      signer: SIGNER,
      request: evmTx(to, `${BLIND_SEL}${"0".repeat(64)}`),
      expect: {
        summary: "contract-call",
        verifiability: "opaque",
        blind: "fiat24-function",
        warnings: [],
        prompt: blindPrompt(to, BLIND_SEL),
      },
    });
  }
  const implData = await call(
    USD24_ABI,
    "transferByAccountId(uint256,uint256)",
    "transferByAccountId",
    [10365n, 20000n],
  );
  const TRANSFER_SEL = implData.slice(0, 10);
  for (const [name, to, chainId, chain] of [
    ["selector-implementation", IMPL_ACCOUNT, 42161, "arb"],
    ["selector-lookalike", LOOKALIKE, 42161, "arb"],
    ["selector-other-chain", USD24, 1, "eth"],
  ] as const) {
    add({
      name,
      signer: SIGNER,
      request: evmTx(to, implData, "0x0", chainId),
      expect: {
        summary: "contract-call",
        verifiability: "opaque",
        blind: "fiat24-function",
        warnings: [],
        prompt: blindPrompt(to, TRANSFER_SEL, chain),
      },
    });
  }
  add({
    name: "transferByAccountId-trailing",
    signer: SIGNER,
    request: evmTx(USD24, `${implData}ff`),
    expect: {
      summary: "contract-call",
      verifiability: "opaque",
      blind: "fiat24-function",
      warnings: [],
      prompt: blindPrompt(USD24, TRANSFER_SEL),
    },
  });
  add({
    name: "approve-nonpayable-value",
    signer: SIGNER,
    request: evmTx(
      USD24,
      await call(USD24_ABI, "approve(address,uint256)", "approve", [CARD, 1n]),
      "0x1",
    ),
    expect: {
      summary: "contract-call",
      verifiability: "opaque",
      blind: "fiat24-function",
      warnings: [],
      prompt: {
        en: [
          "Confirm blind signing",
          NET_EN,
          F24FN_EN,
          `Call contract ${USD24}, function 0x095ea7b3`,
          `Send 0.000000000000000001 ETH to ${USD24}`,
          FEE_EN,
        ].join("\n"),
        "zh-Hans": [
          "确认盲签",
          NET_ZH,
          F24FN_ZH,
          `调用合约 ${USD24}，函数 0x095ea7b3`,
          `发送 0.000000000000000001 ETH 到 ${USD24}`,
          FEE_ZH,
        ].join("\n"),
      },
    },
  });
  const noncashData = await call(
    DEPOSIT_ABI,
    "moneyExchangeExactIn(address,address,uint256)",
    "moneyExchangeExactIn",
    [USDC, EUR24, 1000n],
  );
  add({
    name: "moneyExchange-noncash",
    signer: SIGNER,
    request: evmTx(DEPOSIT, noncashData),
    expect: {
      summary: "contract-call",
      verifiability: "opaque",
      blind: "fiat24-function",
      warnings: [],
      prompt: blindPrompt(DEPOSIT, noncashData.slice(0, 10)),
    },
  });
  const acctApprove = await call(ACCOUNT_ABI, "approve(address,uint256)", "approve", [
    OTHER,
    123456n,
  ]);
  add({
    name: "account-approve",
    signer: SIGNER,
    request: evmTx(ACCOUNT, acctApprove),
    expect: {
      summary: "contract-call",
      verifiability: "opaque",
      blind: "fiat24-function",
      warnings: [],
      prompt: blindPrompt(ACCOUNT, acctApprove.slice(0, 10)),
    },
  });
  const byWallet = await call(
    DEPOSIT_ABI,
    "depositByWallet(address,address,uint256)",
    "depositByWallet",
    [SIGNER, EUR24, 1000n],
  );
  add({
    name: "depositByWallet",
    signer: SIGNER,
    request: evmTx(DEPOSIT, byWallet),
    expect: {
      summary: "contract-call",
      verifiability: "opaque",
      blind: "fiat24-function",
      warnings: [],
      prompt: blindPrompt(DEPOSIT, byWallet.slice(0, 10)),
    },
  });

  /* The two raw grant texts — blind under the Fiat24 session-grant reason. */
  const GRANT_TEXT_1 =
    "I agree to access my profile. 0xfa48d2c6c46ff6b326dbd0a56c06b06795d7b2e3e58fed6b9d367e2917065f82";
  const GRANT_TEXT_2 =
    "I agree to access my Fiat24 profile. 0xfa48d2c6c46ff6b326dbd0a56c06b06795d7b2e3e58fed6b9d367e2917065f82";
  for (const [name, text] of [
    ["grant-text", GRANT_TEXT_1],
    ["grant-text-alt", GRANT_TEXT_2],
  ] as const) {
    add({
      name,
      signer: SIGNER,
      request: {
        kind: "evm.personal-message",
        network: "eip155:42161",
        account,
        message: { $bytes: `0x${Buffer.from(text, "utf8").toString("hex")}` },
      },
      expect: {
        summary: "message",
        verifiability: "opaque",
        blind: "fiat24-session-grant",
        warnings: [],
        prompt: grantPrompt(text),
      },
    });
  }

  /* Wallet-built session grants — every field re-derived with cast and asserted equal to the
     independent @qntx/fiat24 session vectors. */
  for (const row of SESSION_ROWS) {
    const { args, label } = row;
    const digestOut = await run(["cast", "keccak", row.preimage]);
    const digest = digestOut.toLowerCase();
    const eip191Out = await run(["cast", "hash-message", row.message]);
    const eip191 = eip191Out.toLowerCase();
    if (digest !== row.digest.toLowerCase()) {
      throw new Error(`session ${label}: cast keccak ${digest} != vector ${row.digest}`);
    }
    if (eip191 !== row.eip191Hash.toLowerCase()) {
      throw new Error(`session ${label}: cast hash-message ${eip191} != vector`);
    }
    let signature = "";
    if (row.signature !== undefined) {
      const sigOut = await run(["cast", "wallet", "sign", "--private-key", ANVIL_KEY, row.message]);
      signature = sigOut.toLowerCase();
      if (signature !== row.signature.toLowerCase()) {
        throw new Error(`session ${label}: cast signature ${signature} != vector`);
      }
    }
    add({
      name: `fiat24-session-${args.tokenId}`,
      signer: SIGNER,
      request: {
        kind: "evm.fiat24-session",
        network: "eip155:42161",
        account,
        tokenId: args.tokenId,
        deadline: Number(args.deadline),
      },
      session: {
        label,
        digest,
        eip191Hash: eip191,
        ...(signature === "" ? {} : { signature }),
      },
      expect: {
        summary: "message",
        verifiability: "partial",
        warnings: [],
        prompt: sessionPrompt(args.tokenId, args.deadline, row.message),
      },
    });
    await sleep(50);
  }

  const out = {
    schema: 1,
    capability: "chains.fiat24",
    source: {
      kind: "reference",
      name: "sourcify+cast+viem",
      version: "1.0.0",
      evidence:
        "ABIs via Sourcify v2 for the seven pinned Fiat24 implementations (per-contract url and keccak256 of the canonical ABI JSON below); calldata via viem encodeFunctionData cross-checked byte-for-byte against `cast calldata`; session grants via `cast keccak`/`cast hash-message`/`cast wallet sign` asserted equal to the embedded @qntx/fiat24 vectors/api/session.json rows (cast 1.10.0); the NUL-padded clientPayoutRef fetched verbatim from tx 0xbe87afca37b50fc68a3dd9ea5b18c6377b50f7491085f3989c6f04131439dea3 via eth_getTransactionByHash on the archive RPC; expected prompts written by hand in the generator",
      generator: "scripts/vectors/fiat24.ts",
      sourcify,
    },
    cases,
  };
  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${OUT}: ${cases.length} cases`);
};

await main();
