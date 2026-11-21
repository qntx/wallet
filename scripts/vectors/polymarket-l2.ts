/// <reference types="node" />
/**
 * Regenerates vectors/chains/polymarket-l2.json — Polymarket CLOB L2 request headers as the
 * reference client produces them, for the kernel's `polymarket.signL2` oracle comparison.
 *
 * Oracle: `createL2Headers` exported by @polymarket/clob-client-v2@1.2.1 (it calls its own
 * `buildPolyHmacSignature`: url-safe base64 WITH `=` padding of HMAC-SHA256 over
 * `${timestamp}${method}${requestPath}${body}`; the secret is decoded by its `decodeBase64Secret`,
 * which normalizes `-`/`_` to `+`/`/` and pads). The signer is a viem `mnemonicToAccount` of the
 * common test mnemonic (m/44'/60'/0'/0/0) behind the wallet-client `ClobSigner` shim, so
 * `POLY_ADDRESS` is that account's EIP-55 address — the same owner the kernel derives for group 0.
 *
 * `secret` appears in the three encodings the import accepts — standard base64 with `+`/`/` and `=`
 * padding, url-safe with `-`/`_`, and unpadded — all decoding to the same 32-byte key, so the
 * signatures of one (timestamp, method, path, body) tuple agree across encodings. Each request is
 * an allow-listed (method, path) pair the kernel signs.
 *
 * Run from the repo root: bun scripts/vectors/polymarket-l2.ts
 */
import { writeFileSync } from "node:fs";

import { createL2Headers } from "@polymarket/clob-client-v2";
import type { WalletClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ACCOUNT = mnemonicToAccount(MNEMONIC);

/* The same 32-byte key in each accepted encoding (standard padded, url-safe padded, standard
   unpadded) — assert rather than assume the alphabets it exercises. */
const SECRETS = [
  { encoding: "standard-padded", secret: "lqe4ydrr/A0eL0BRYnOElaa3yNnq+wwdLj9QYXKDlKU=" },
  { encoding: "urlsafe-padded", secret: "lqe4ydrr_A0eL0BRYnOElaa3yNnq-wwdLj9QYXKDlKU=" },
  { encoding: "standard-unpadded", secret: "lqe4ydrr/A0eL0BRYnOElaa3yNnq+wwdLj9QYXKDlKU" },
] as const;
const API_KEY = "7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a2";
const PASSPHRASE = "test-passphrase-1";
const ORDER_ID = `0x${"ab".repeat(32)}`;
/* A POST /order body as the client posts it (docs trading_place-orders.md): deferExec, the signed
   order fields as strings, orderType and the credential owner apiKey. */
const ORDER_BODY = JSON.stringify({
  deferExec: false,
  order: {
    builder: "0x0000000000000000000000000000000000000000000000000000000000000000",
    expiration: "0",
    maker: "0x3000000000000000000000000000000000000003",
    makerAmount: "1000000",
    metadata: "0x",
    salt: 17150000,
    side: "BUY",
    signature: `0x${"cd".repeat(65)}`,
    signatureType: 3,
    signer: "0x3000000000000000000000000000000000000003",
    takerAmount: "520000",
    timestamp: "1767225600000",
    tokenId: "1020841950285360493905677148747669939968146964242217012704228145026484497",
  },
  orderType: "GTC",
  owner: API_KEY,
  postOnly: false,
});
const CANCEL_BODY = JSON.stringify([ORDER_ID, `0x${"ef".repeat(32)}`]);

const assert: (ok: boolean, what: string) => asserts ok = (ok, what) => {
  if (!ok) {
    throw new Error(`polymarket-l2 vector mismatch: ${what}`);
  }
};

assert(
  SECRETS[0].secret.includes("+") &&
    SECRETS[0].secret.includes("/") &&
    SECRETS[0].secret.endsWith("="),
  "standard-padded secret exercises + / and = padding",
);
assert(
  SECRETS[1].secret.includes("-") &&
    SECRETS[1].secret.includes("_") &&
    SECRETS[1].secret.endsWith("="),
  "url-safe padded secret exercises - _ and = padding",
);
assert(!SECRETS[2].secret.includes("="), "unpadded secret carries no padding");

/** The wallet-client `ClobSigner`: `account` resolves the address, `signTypedData` is unused by L2. */
const signerClient = {
  account: ACCOUNT,
  signTypedData: ACCOUNT.signTypedData.bind(ACCOUNT),
};
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- L2 only reads account.address
const signer = signerClient as unknown as WalletClient;

type RequestCase = {
  readonly method: string;
  readonly path: string;
  readonly body?: string;
};

const REQUESTS: ReadonlyArray<RequestCase> = [
  { method: "GET", path: "/data/orders" },
  { method: "GET", path: `/data/order/${ORDER_ID}` },
  { method: "POST", path: "/order", body: ORDER_BODY },
  { method: "DELETE", path: "/orders", body: CANCEL_BODY },
  { method: "DELETE", path: "/cancel-all" },
  { method: "GET", path: "/balance-allowance/update" },
];

const cases = [];
for (const { encoding, secret } of SECRETS) {
  for (const [ri, request] of REQUESTS.entries()) {
    const timestamp = 1_767_225_600 + ri * 60; // fixed; the kernel test injects this clock
    // oxlint-disable-next-line eslint/no-await-in-loop -- cases generate sequentially
    const headers = await createL2Headers(
      signer,
      { key: API_KEY, secret, passphrase: PASSPHRASE },
      {
        method: request.method,
        requestPath: request.path,
        ...(request.body === undefined ? {} : { body: request.body }),
      },
      timestamp,
    );
    cases.push({
      name: `${encoding}-${request.method}-${request.path.split("/").filter(Boolean).join("-")}`,
      secret,
      passphrase: PASSPHRASE,
      apiKey: API_KEY,
      timestamp,
      method: request.method,
      path: request.path,
      ...(request.body === undefined ? {} : { body: request.body }),
      headers,
    });
  }
}

/* Every encoding of one (timestamp, method, path, body) tuple signs identically — sanity. */
for (const request of REQUESTS) {
  const sigs = new Set(
    cases
      .filter((c) => c.method === request.method && c.path === request.path)
      .map((c) => c.headers.POLY_SIGNATURE),
  );
  assert(sigs.size === 1, `encodings disagree on ${request.method} ${request.path}`);
}
assert(
  cases.every((c) => c.headers.POLY_ADDRESS === ACCOUNT.address),
  "POLY_ADDRESS is the signer",
);

const out = {
  comment:
    "TEST ONLY. Polymarket CLOB L2 headers per @polymarket/clob-client-v2@1.2.1 createL2Headers/buildPolyHmacSignature: url-safe base64 (`=` padding kept) HMAC-SHA256 over timestamp + method + requestPath + body keyed by decodeBase64Secret(secret). One key in the three accepted encodings; signer = viem mnemonicToAccount('abandon … about') at m/44'/60'/0'/0/0. Generated by scripts/vectors/polymarket-l2.ts.",
  account: ACCOUNT.address,
  cases,
};

writeFileSync("vectors/chains/polymarket-l2.json", `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote vectors/chains/polymarket-l2.json (${cases.length} cases)`);
