import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import * as AbiFunction from "ox/AbiFunction";

import { ChainError } from "../index.ts";
import type { Fiat24Action, IntentSummary, AssetFlow, IntentWarning } from "../index.ts";
import { checksumEvmAddress } from "./address.ts";
import { EVM_NATIVE_ASSET } from "./assets.ts";
import { lookupEvmToken } from "./tokens.ts";
import type { EvmTokenTable } from "./tokens.ts";
import { assertHex } from "./transaction.ts";

/**
 * The Fiat24 contracts (SR Saphirstein AG) the decoder recognises by address — Arbitrum One only.
 * The pinned proxies come from the issuer's own list
 * (https://docs.fiat24.com/developer/integration-guide/part-1-smart-contracts.md) re-read on chain
 * at block 526439604: EIP-1967 implementation slots, symbol()/decimals() — Sourcify full matches,
 * solc 0.8.18.
 */
export const FIAT24_CHAIN = 42161;

/** The ERC-721 "Fiat24 Account" — each token id is a client account. */
export const FIAT24_ACCOUNT = "0x133CAEecA096cA54889db71956c7f75862Ead7A0";

/** The FX/top-up contract (Fiat24CryptoDeposit). */
export const FIAT24_DEPOSIT = "0x4582f67698843Dfb6A9F195C0dDee05B0A8C973F";

/** The card-authorisation contract (Fiat24CardAuthorizationMarqeta). */
export const FIAT24_CARD = "0xe2e3B88B9893e18D0867c08f9cA93f8aB5935b14";

/**
 * The deposit contract's `usdc()` — every Fiat24 top-up routes through it
 * (Fiat24CryptoDeposit.sol:66; Arbitrum One USDC).
 */
export const FIAT24_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

/**
 * The four cash tokens, keyed by lowercase address; each carries its checksummed form. All four
 * share the one Fiat24Token.sol source and `decimals()` is the constant 2 (Fiat24Token.sol:256-258;
 * issuer list above).
 */
export const FIAT24_TOKENS: Readonly<
  Record<string, { readonly address: string; readonly symbol: string }>
> = {
  "0xbe00f3db78688d9704bcb4e0a827aea3a9cc0d62": {
    address: "0xbE00f3db78688d9704BCb4e0a827aea3a9Cc0D62",
    symbol: "USD24",
  },
  "0x2c5d06f591d0d8cd43ac232c2b654475a142c7da": {
    address: "0x2c5d06f591D0d8cd43Ac232c2B654475a142c7DA",
    symbol: "EUR24",
  },
  "0xd41f1f0cf89fd239ca4c1f8e8ada46345c86b0a4": {
    address: "0xd41F1f0cf89fD239ca4c1F8E8ADA46345c86b0a4",
    symbol: "CHF24",
  },
  "0x7288ac74d211735374a23707d1518dcbbc0144fd": {
    address: "0x7288Ac74d211735374A23707D1518DCbbc0144fd",
    symbol: "CNH24",
  },
};

/* The issuer's internal accounts — the contract itself bounds the range
   (Fiat24Account.sol:299,318): ids 9100–9299 are treasury/payout desks, not clients. */
const INTERNAL_ACCOUNT_MIN = 9100n;
const INTERNAL_ACCOUNT_MAX = 9299n;

const TRANSFER_BY_ACCOUNT_ID = AbiFunction.from(
  "function transferByAccountId(uint256 accountId, uint256 amount)",
);
const CLIENT_PAYOUT = AbiFunction.from("function clientPayout(uint256 amount, string contactId)");
const CLIENT_PAYOUT_REF = AbiFunction.from(
  "function clientPayoutRef(uint256 amount, string contactId, uint256 purposeId, string ref)",
);
const MONEY_EXCHANGE_EXACT_IN = AbiFunction.from(
  "function moneyExchangeExactIn(address input, address output, uint256 amount)",
);
const MONEY_EXCHANGE_EXACT_OUT = AbiFunction.from(
  "function moneyExchangeExactOut(address input, address output, uint256 amount)",
);
const DEPOSIT_TOKEN_VIA_USDC = AbiFunction.from(
  "function depositTokenViaUsdc(address input, address output, uint256 amount)",
);
const DEPOSIT_ETH = AbiFunction.from("function depositETH(address output) payable");
const DEPOSIT_TOKEN_VIA_ETH = AbiFunction.from(
  "function depositTokenViaEth(address input, address output, uint256 amount)",
);
const MINT_BY_CLIENT = AbiFunction.from("function mintByClient(uint256 tokenId)");
const MINT_BY_CLIENT_WITH_ETH = AbiFunction.from(
  "function mintByClientWithETH(uint256 tokenId) payable",
);

/* Plain ERC-721 movement on the account contract — generic selectors the family claims
   only at the pinned proxy, so they do not join FIAT24_FUNCTIONS. */
const ACCOUNT_TRANSFER_FROM = AbiFunction.from(
  "function transferFrom(address from, address to, uint256 tokenId)",
);
const ACCOUNT_SAFE_TRANSFER = AbiFunction.from(
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
);
const ACCOUNT_SAFE_TRANSFER_DATA = AbiFunction.from(
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
);

/* The functions only Fiat24 contracts carry — selectors derived from the Sourcify-verified
   ABIs (https://sourcify.dev/server/v2/contract/42161/<impl> for each implementation); each is
   collision-free in the 4byte signature database
   (https://api.4byte.sourcify.dev/signature-database/v1/lookup). A selector's presence in
   calldata claims the Fiat24 family whatever the callee or chain. */
const FIAT24_FUNCTIONS: ReadonlyArray<AbiFunction.AbiFunction> = [
  TRANSFER_BY_ACCOUNT_ID,
  CLIENT_PAYOUT,
  CLIENT_PAYOUT_REF,
  MONEY_EXCHANGE_EXACT_IN,
  MONEY_EXCHANGE_EXACT_OUT,
  DEPOSIT_TOKEN_VIA_USDC,
  DEPOSIT_ETH,
  DEPOSIT_TOKEN_VIA_ETH,
  MINT_BY_CLIENT,
  MINT_BY_CLIENT_WITH_ETH,
];

const FIAT24_SELECTORS: ReadonlySet<string> = new Set(
  FIAT24_FUNCTIONS.map((fn) => AbiFunction.getSelector(fn)),
);

/* ERC-20 selectors whose calls to a cash token go through the standard token path. */
const ERC20_SELECTORS: ReadonlySet<string> = new Set(
  [
    "function transfer(address to, uint256 amount)",
    "function approve(address spender, uint256 amount)",
    "function increaseAllowance(address spender, uint256 amount)",
    "function decreaseAllowance(address spender, uint256 amount)",
    "function transferFrom(address from, address to, uint256 amount)",
  ].map((signature) => AbiFunction.getSelector(signature)),
);

const FIAT24_CONTRACTS = new Set(
  [FIAT24_ACCOUNT, FIAT24_DEPOSIT, FIAT24_CARD, ...Object.keys(FIAT24_TOKENS)].map((a) =>
    a.toLowerCase(),
  ),
);

/** `to` is one of the seven pinned Fiat24 proxies on Arbitrum One. */
export const isFiat24Contract = (chainId: number, to: string): boolean =>
  chainId === FIAT24_CHAIN && FIAT24_CONTRACTS.has(to.toLowerCase());

/** `data` starts with a Fiat24-specific selector (any callee, any chain). */
export const hasFiat24Selector = (data: string): boolean =>
  FIAT24_SELECTORS.has(data.slice(0, 10).toLowerCase());

/** The spender's role when it is a Fiat24 contract on Arbitrum One. */
export const fiat24Spender = (chainId: number, spender: string): "card" | "deposit" | undefined => {
  if (chainId !== FIAT24_CHAIN) {
    return undefined;
  }
  const address = spender.toLowerCase();
  return address === FIAT24_CARD.toLowerCase()
    ? "card"
    : address === FIAT24_DEPOSIT.toLowerCase()
      ? "deposit"
      : undefined;
};

/** Canonical-encoding decode like `tryCall` in decode.ts — undefined on any mismatch. */
const tryCall = (fn: AbiFunction.AbiFunction, data: string): ReadonlyArray<unknown> | undefined => {
  const selector = AbiFunction.getSelector(fn);
  if (!data.toLowerCase().startsWith(selector)) {
    return undefined;
  }
  try {
    assertHex(data, "data");
    const args: unknown = AbiFunction.decodeData(fn, data);
    if (!Array.isArray(args)) {
      return undefined;
    }
    const reencoded = AbiFunction.encodeData(fn, args);
    return reencoded.toLowerCase() === data.toLowerCase() ? args : undefined;
  } catch {
    return undefined;
  }
};

const argUint = (args: ReadonlyArray<unknown>, index: number): bigint => {
  const value = args[index];
  if (typeof value !== "bigint") {
    throw new ChainError("invalid-request", "decoded argument is not a uint256");
  }
  return value;
};

const argAddress = (args: ReadonlyArray<unknown>, index: number): string => {
  const value = args[index];
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new ChainError("invalid-request", "decoded argument is not an address");
  }
  return checksumEvmAddress(value);
};

const argString = (args: ReadonlyArray<unknown>, index: number): string => {
  const value = args[index];
  if (typeof value !== "string") {
    throw new ChainError("invalid-request", "decoded argument is not a string");
  }
  return value;
};

/** What a recognised Fiat24 call contributes to the intent. */
export type Fiat24Decode = {
  readonly summary: IntentSummary;
  readonly outflows: ReadonlyArray<AssetFlow>;
  readonly warnings: ReadonlyArray<IntentWarning>;
  readonly fiat24?: Fiat24Action;
};

type DecodeResult = { readonly decoded: Fiat24Decode } | "claimed" | undefined;
type ValueCall = { readonly value: bigint; readonly data: string };
type CashToken = { readonly address: string; readonly symbol: string };

/* One described function: `payable` marks the calls that must carry value (depositETH,
   mintByClientWithETH); a selector match that fails the value check is a near miss. */
type Fiat24Case = {
  readonly fn: AbiFunction.AbiFunction;
  readonly payable?: boolean;
  readonly run: (args: ReadonlyArray<unknown>, call: ValueCall) => Fiat24Decode | "claimed";
};

/* First matching selector wins; the single value guard and every "claimed" result end the
   decode. No match returns undefined so the caller can apply its own fallback. */
const runCases = (cases: ReadonlyArray<Fiat24Case>, call: ValueCall): DecodeResult => {
  for (const c of cases) {
    const args = tryCall(c.fn, call.data);
    if (args === undefined) {
      continue;
    }
    if (c.payable === true ? call.value === 0n : call.value > 0n) {
      return "claimed";
    }
    const decoded = c.run(args, call);
    return decoded === "claimed" ? "claimed" : { decoded };
  }
  return undefined;
};

const tokenAmount = (token: string, amount: bigint, chainId: number, table: EvmTokenTable) => {
  const known = lookupEvmToken(table, chainId, token);
  return {
    asset: token,
    amount: amount.toString(10),
    ...(known === undefined ? {} : { symbol: known.symbol, decimals: known.decimals }),
  };
};

/** The cash-token row for an address argument, or undefined for any other token. */
const cashToken = (address: string) => FIAT24_TOKENS[address.toLowerCase()];

const fiat24Token = (token: CashToken) => ({
  asset: token.address,
  symbol: token.symbol,
  decimals: 2 as const,
});

/** Verified outflow of a cash-token amount; `fiat24` names the account or payee the bytes carry. */
const cashFlow = (
  token: CashToken,
  amount: bigint,
  chainId: number,
  table: EvmTokenTable,
  fiat24: { readonly account: string } | { readonly payee: string },
): AssetFlow => ({
  to: token.address,
  amount: tokenAmount(token.address, amount, chainId, table),
  verified: true,
  fiat24,
});

const ethFlow = (to: string, value: bigint): AssetFlow => ({
  to,
  amount: { asset: EVM_NATIVE_ASSET, amount: value.toString(10) },
  verified: true,
});

/** A top-up input paid to the deposit contract — verified only when the token table knows it. */
const topUpFlow = (
  input: string,
  amount: bigint,
  chainId: number,
  table: EvmTokenTable,
): AssetFlow => ({
  to: FIAT24_DEPOSIT,
  amount: tokenAmount(input, amount, chainId, table),
  verified: lookupEvmToken(table, chainId, input) !== undefined,
});

/* clientPayout(Ref) pays out by bank transfer: the bytes name the payee id, Fiat24 resolves the
   receiving account off-chain — the outflow carries the id, the action the verbatim strings. */
const payout = (
  token: CashToken,
  args: ReadonlyArray<unknown>,
  action: (contactId: string) => Fiat24Action,
  chainId: number,
  table: EvmTokenTable,
): Fiat24Decode => {
  const contactId = argString(args, 1);
  return {
    summary: "payout",
    outflows: [cashFlow(token, argUint(args, 0), chainId, table, { payee: contactId })],
    warnings: [{ kind: "fiat24-payee-offchain", message: "" }],
    fiat24: action(contactId),
  };
};

/** Both exchange sides need two different cash tokens — anything else is a near miss. */
const exchangePair = (args: ReadonlyArray<unknown>) => {
  const input = cashToken(argAddress(args, 0));
  const output = cashToken(argAddress(args, 1));
  return input === undefined || output === undefined || input.address === output.address
    ? undefined
    : { input, output };
};

/* The FX exchanges swap between cash tokens at the issuer-set rate: the rate is operator
   storage, so the bytes cannot bound what the call receives. */
const exchangeIn = (
  args: ReadonlyArray<unknown>,
  chainId: number,
  table: EvmTokenTable,
): Fiat24Decode | "claimed" => {
  const pair = exchangePair(args);
  if (pair === undefined) {
    return "claimed";
  }
  return {
    summary: "swap",
    outflows: [
      {
        to: FIAT24_DEPOSIT,
        amount: tokenAmount(pair.input.address, argUint(args, 2), chainId, table),
        verified: true,
      },
    ],
    warnings: [{ kind: "fiat24-issuer-rate", message: "" }],
    fiat24: { kind: "exchange", side: "exact-in", receive: fiat24Token(pair.output) },
  };
};

const exchangeOut = (
  args: ReadonlyArray<unknown>,
  chainId: number,
  table: EvmTokenTable,
): Fiat24Decode | "claimed" => {
  const pair = exchangePair(args);
  if (pair === undefined) {
    return "claimed";
  }
  return {
    summary: "swap",
    outflows: [],
    warnings: [
      { kind: "fiat24-issuer-rate", message: "" },
      { kind: "fiat24-exact-out-unbounded", message: "" },
    ],
    fiat24: {
      kind: "exchange",
      side: "exact-out",
      pay: fiat24Token(pair.input),
      receive: tokenAmount(pair.output.address, argUint(args, 2), chainId, table),
    },
  };
};

/** A top-up's shared shape: pay in, receive a cash token at a rate the transaction cannot bound. */
const topUp = (
  outflows: ReadonlyArray<AssetFlow>,
  output: CashToken,
  swapsInTx: boolean,
): Fiat24Decode => ({
  summary: "swap",
  outflows,
  warnings: [
    { kind: "fiat24-issuer-rate", message: "" },
    ...(swapsInTx ? [{ kind: "fiat24-swap-quote" as const, message: "" }] : []),
  ],
  fiat24: { kind: "top-up", receive: fiat24Token(output) },
});

/* depositTokenViaUsdc/depositTokenViaEth settle a listed or unlisted token input into a cash
   token; `swapsInTx` marks inputs that trade inside the transaction (anything but USDC). */
const topUpToken = (
  args: ReadonlyArray<unknown>,
  swapsInTx: (input: string) => boolean,
  chainId: number,
  table: EvmTokenTable,
): Fiat24Decode | "claimed" => {
  const input = argAddress(args, 0);
  const output = cashToken(argAddress(args, 1));
  if (output === undefined) {
    return "claimed";
  }
  return topUp([topUpFlow(input, argUint(args, 2), chainId, table)], output, swapsInTx(input));
};

/** Minting an account permanently links the address to the identity Fiat24 verifies. */
const openAccount = (id: bigint, outflows: ReadonlyArray<AssetFlow>): Fiat24Decode => ({
  summary: "contract-call",
  outflows,
  warnings: [{ kind: "fiat24-account-link", message: "" }],
  fiat24: { kind: "open-account", account: id.toString(10) },
});

/* Moving the account NFT moves control of the account — its balance and the identity verified
   for it. */
const moveAccount = (args: ReadonlyArray<unknown>): Fiat24Decode => {
  const to = argAddress(args, 1);
  const id = argUint(args, 2);
  return {
    summary: "transfer",
    outflows: [
      {
        to,
        amount: { asset: FIAT24_ACCOUNT, amount: "1", tokenId: id.toString(10) },
        verified: false,
      },
    ],
    warnings: [
      { kind: "fiat24-account-move", level: "danger", message: `#${id.toString(10)} → ${to}` },
    ],
  };
};

/* A call to a cash token: `transferByAccountId` resolves the recipient on chain at execution —
   the bytes name only the account id — and the five ERC-20 selectors fall through to the
   standard token path. Everything else is a Fiat24 call the family claims. */
const decodeFiat24Token = (
  token: CashToken,
  call: ValueCall,
  chainId: number,
  table: EvmTokenTable,
): DecodeResult => {
  const hit = runCases(
    [
      {
        fn: TRANSFER_BY_ACCOUNT_ID,
        run: (args) => {
          const account = argUint(args, 0);
          return {
            summary: "transfer",
            outflows: [
              cashFlow(token, argUint(args, 1), chainId, table, {
                account: account.toString(10),
              }),
            ],
            warnings:
              account >= INTERNAL_ACCOUNT_MIN && account <= INTERNAL_ACCOUNT_MAX
                ? [{ kind: "fiat24-internal-account", message: account.toString(10) }]
                : [],
          };
        },
      },
      {
        fn: CLIENT_PAYOUT,
        run: (args) =>
          payout(token, args, (contactId) => ({ kind: "payout", contactId }), chainId, table),
      },
      {
        fn: CLIENT_PAYOUT_REF,
        run: (args) =>
          payout(
            token,
            args,
            (contactId) => ({
              kind: "payout",
              contactId,
              purposeId: argUint(args, 2).toString(10),
              ref: argString(args, 3),
            }),
            chainId,
            table,
          ),
      },
    ],
    call,
  );
  if (hit !== undefined) {
    return hit;
  }
  const selector = call.data.slice(0, 10).toLowerCase();
  return ERC20_SELECTORS.has(selector) && call.value === 0n ? undefined : "claimed";
};

/* A call into the deposit/top-up contract: the FX exchanges and the three top-ups, decoded as
   above; `depositByWallet` and the rest of the wallet-provider/operator surface stay claimed. */
const decodeFiat24Deposit = (
  call: ValueCall,
  chainId: number,
  table: EvmTokenTable,
): DecodeResult =>
  runCases(
    [
      { fn: MONEY_EXCHANGE_EXACT_IN, run: (args) => exchangeIn(args, chainId, table) },
      { fn: MONEY_EXCHANGE_EXACT_OUT, run: (args) => exchangeOut(args, chainId, table) },
      {
        fn: DEPOSIT_TOKEN_VIA_USDC,
        run: (args) =>
          topUpToken(
            args,
            (input) => input.toLowerCase() !== FIAT24_USDC.toLowerCase(),
            chainId,
            table,
          ),
      },
      {
        fn: DEPOSIT_ETH,
        payable: true,
        run: (args, call) => {
          const output = cashToken(argAddress(args, 0));
          return output === undefined
            ? "claimed"
            : topUp([ethFlow(FIAT24_DEPOSIT, call.value)], output, true);
        },
      },
      {
        fn: DEPOSIT_TOKEN_VIA_ETH,
        run: (args) => topUpToken(args, () => true, chainId, table),
      },
    ],
    call,
  ) ?? "claimed";

/* A call into the account contract: minting opens an account whose token id is the account
   number, and moving the NFT moves control of it. `approve`/`setApprovalForAll` and the
   wallet/operator surface stay claimed. */
const decodeFiat24Account = (call: ValueCall): DecodeResult =>
  runCases(
    [
      { fn: MINT_BY_CLIENT, run: (args) => openAccount(argUint(args, 0), []) },
      {
        fn: MINT_BY_CLIENT_WITH_ETH,
        payable: true,
        run: (args, call) => openAccount(argUint(args, 0), [ethFlow(FIAT24_ACCOUNT, call.value)]),
      },
      { fn: ACCOUNT_SAFE_TRANSFER_DATA, run: moveAccount },
      { fn: ACCOUNT_SAFE_TRANSFER, run: moveAccount },
      { fn: ACCOUNT_TRANSFER_FROM, run: moveAccount },
    ],
    call,
  ) ?? "claimed";

/**
 * Decodes a call to a Fiat24 contract: `{ decoded }` for the calls the rules table describes,
 * `"claimed"` for every other call into one of the seven pinned proxies (the Fiat24 family's
 * near-miss reason applies), `undefined` when the call is not Fiat24's — a cash token's ERC-20
 * selectors, or a callee Fiat24 does not own.
 *
 * Only `depositETH` and `mintByClientWithETH` are payable; a positive value on any other function
 * is a near miss.
 */
export const decodeFiat24 = (
  chainId: number,
  call: { readonly to: string | undefined; readonly value: bigint; readonly data: string },
  table: EvmTokenTable,
): DecodeResult => {
  if (chainId !== FIAT24_CHAIN || call.to === undefined) {
    return undefined;
  }
  const to = call.to.toLowerCase();
  const token = FIAT24_TOKENS[to];
  if (token !== undefined) {
    return decodeFiat24Token(token, call, chainId, table);
  }
  if (to === FIAT24_DEPOSIT.toLowerCase()) {
    return decodeFiat24Deposit(call, chainId, table);
  }
  if (to === FIAT24_ACCOUNT.toLowerCase()) {
    return decodeFiat24Account(call);
  }
  return FIAT24_CONTRACTS.has(to) ? "claimed" : undefined;
};

/* The grant message the Fiat24 API verifies: "I agree to access my profile. " followed by the
   deadline hash (integration guide part-2-api-reference, Secured APIs). The label the wallet
   hashes is its own convention — it pins the session to the chain, account token and deadline
   so a grant cannot be replayed under different terms. */
const sessionLabel = (chainId: number, tokenId: string, deadline: number): string =>
  `fiat24-session-v1:${chainId}:${tokenId}:${deadline}`;

/** The exact personal-message text a `evm.fiat24-session` request signs. */
export const fiat24SessionMessage = (
  chainId: number,
  tokenId: string,
  deadline: number,
): string => {
  const digest = `0x${bytesToHex(keccak_256(utf8ToBytes(sessionLabel(chainId, tokenId, deadline) + deadline)))}`;
  return `I agree to access my profile. ${digest}`;
};
