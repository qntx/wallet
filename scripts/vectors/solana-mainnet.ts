/// <reference types="node" />
// oxlint-disable eslint/no-await-in-loop -- requests are sequential and throttled by design
/**
 * Regenerates vectors/chains/solana-mainnet.json: real mainnet transactions used as Solana
 * transaction-decoder fixtures, two per program family.
 *
 * The oracle is the public RPC https://api.mainnet-beta.solana.com: each signature is re-fetched
 * with getTransaction (encoding base64, maxSupportedTransactionVersion 0), the message is the wire
 * bytes after the signature vector, and the lookup tables are reconstructed by fetching each ALT
 * account — the reconstruction must equal meta.loadedAddresses exactly. When a signature can no
 * longer be fetched or fails verification, the entry already in the output file is kept.
 *
 * Run from the repo root: bun scripts/vectors/solana-mainnet.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the CJS require is untyped
const { getCompiledTransactionMessageDecoder } = require("@solana/transaction-messages") as {
  getCompiledTransactionMessageDecoder: () => {
    decode: (b: Uint8Array) => {
      staticAccounts: ReadonlyArray<string>;
      addressTableLookups?: ReadonlyArray<{
        lookupTableAddress: string;
        writableIndexes: ReadonlyArray<number>;
        readonlyIndexes: ReadonlyArray<number>;
      }>;
    };
  };
};
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the CJS require is untyped
const { getAddressDecoder } = require("@solana/addresses") as {
  getAddressDecoder: () => { decode: (b: Uint8Array) => string };
};

const RPC = "https://api.mainnet-beta.solana.com";
const OUT = "vectors/chains/solana-mainnet.json";

/** [label, program, signature] — the 36 fixtures the vector file carries. */
const FIXTURES: ReadonlyArray<readonly [string, string, string]> = [
  [
    "Raydium AMM v4",
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    "zYfMbwWqc26iuxR8vEQKcgQKaFeYtrqbaoRHPD16mm8uFWRWoxRQTy5NAc3NSoGSxFgRpy2uTqjdU21mdGpWWEq",
  ],
  [
    "Raydium AMM v4",
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    "4ZgGzFAQUZW2EopfWqgQkFmRccYqDXuCVRnbBpR4wR9xGMZKyuNjZySwKZwd8eQNSf9YTSeH3fmcnMpLzpULvMf1",
  ],
  [
    "Raydium CLMM",
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    "3c196gtidd98gz7oL1G9FeyzudjoSujeHGvBhqVkWXY5eim1sbufUbgAPAddnH46XRz9pH8D1an91SLthbrsMgF3",
  ],
  [
    "Raydium CLMM",
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    "5SXmd3gsbs8mSLQM7nuWzqZyANHWbe68McUz8F8Y1bV9UJ9yLFqJ8VhW7Aw5suNXQrXtnBrF9hQKwEBczNoX7L9z",
  ],
  [
    "Raydium CPMM",
    "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    "5pm4LpEeFQYzmJipjpZjtoyKJDTUhNx8kBhwHitTL2uRKJ2j9PsDvU8z1q8jCtcuoP1SbamebCuMWWf1X67zqfxh",
  ],
  [
    "Raydium CPMM",
    "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    "4jm6EBbGnmZNeR5nLiER8p7VEVBAcR8MKvDcpRAgktxGfddA3Zyi1c1pqqyGKseeYtFFPUJLELNScfEyNDvRe3pt",
  ],
  [
    "Orca Whirlpool",
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    "2cu4yxFLmq8r5kYb87ZbiCBXjb6FgkVwkDDdXrQzPo8UFuiLkZ2ZcMRTqgcAGcLiSwDMXgLneHLytrkTG6S8bCFw",
  ],
  [
    "Orca Whirlpool",
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    "28zvUEaiK5mhcHkSeMfEr1DTdkiJAcMYvf6FLZvTyAwBMpom4oghKutSfwu5TTPxAhYtYHt4yACuoJDc2PGJ9Doy",
  ],
  [
    "Meteora DAMM v2",
    "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
    "5TxQMHyNe9zG8NqBbaBY1EQVtCXSjqHUo2XAtpSeBkjHSfzGwnswjR29yzYL2q8XvU8Hjkk7QitRXT6twGzyG241",
  ],
  [
    "Meteora DAMM v2",
    "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
    "4Gw1daGSyTk1cuooociZhoUdGiJcsqwwdi53EuGXwaYXMFFiCWJHoyEXXTgfAvymqrrx8qrdZ5H4PFAsEJLWjpZd",
  ],
  [
    "Pump.fun",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "3RKLg59qHt393hCXT2UU3L1aBjRY2QxMYKwMxSGEkXpprjwYzZjvVB8N9U2E5B8Withwr3s5gxtR3J8yysRhVTzG",
  ],
  [
    "Pump.fun",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "4TbJ8ktGJ21HcKNshbM3gzLucv11Jvgx6qqjehrsXytZCRSsJ1FRGk14JDcjj4XHpDi1uUcpf521BKQRJnBUsz3J",
  ],
  [
    "PumpSwap",
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    "yArWhwYWvJAdH5pFSVyArc1imbNGv5oB3oHeQLPpxvCmd3EshYXJQoEG6Xxp2hC15QpmE5ioGf3kGpreMcuiJMF",
  ],
  [
    "PumpSwap",
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    "48CgRHsnfc38qgFtXcLDZ1KdxadRAS2sq4vX9Va1sGu8ASFMxSAijPNmAKMyFFSExgfYhy5vgA3qzTTr35nZVgEL",
  ],
  [
    "Kamino Lend",
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
    "2i2KaJa2hbNGuFE4uaoqbpg8Xti5yp4adb9Ls1PNpokTDrueg9U5f4Mcsurcqq3tBKH68j2VthGApLSFHfEutCak",
  ],
  [
    "Kamino Lend",
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
    "2g8W344o3APTePyQLSQsDXJsPQ1QgwaG1aANhx6NHTJWdHdkRwhDnsXVccAuij5ZsRsbE6NrSGbCQ7QJ8FFuzbwZ",
  ],
  [
    "marginfi v2",
    "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    "55WEmE2mabLYfkY3A9NYpJVEtf49jmpUJGqsgu3RSu8pkUPLWgnwXk2HnTt4DasNZW98L4LGsxPHwHDJJy1uGwZW",
  ],
  [
    "marginfi v2",
    "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    "2vd7c6nHgafKD5cSmUtu6dX5rTRwaG6uQi2QBE33nGh3f2Lz9GNZdfBd6NnyoqT88vZdKNjM8UGyic9ock96V1K8",
  ],
  [
    "Marinade",
    "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD",
    "64dQeTRdnDBXyrNUJjdTwDS9gF5PPxuwEAczsbgBRvsjSMJhJqgpJsQpvMFE4kznr1xXUC2xrs3rC5XmzDdi7tV3",
  ],
  [
    "Marinade",
    "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD",
    "d8ASHGbcZy4wMyuTxuUUNRPx31DD4FtxpPTC17zaBnHFfJB4AgC5FnUvdPsgNxv2NqXteR2FPogdZ2ynW78Dz6R",
  ],
  [
    "SPL Stake Pool (JitoSOL)",
    "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
    "5BNpKjy1yVdpXUe7BBirctH9JsTySUavtFaMLbKkS4nYwTV2jpWKXCHCj7fdikCHVGmjHSsBc4GUpXAfx87qBJ1U",
  ],
  [
    "SPL Stake Pool (JitoSOL)",
    "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
    "wSFiqNWATBKumzisFHREkeXW1tVtgd9fZ9xB3TT8KBrfpc8GoRy9tSvipEr6cLv7nN3z5q3Roj7bD5TdrThAMWx",
  ],
  [
    "Magic Eden M2",
    "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K",
    "3eUMQBKD7GJokd7Uc6RbqGWEyZ9Y4A4GNNNiYAeKtB6R5pTpeEzhnqtJvAJL7ay9aHfmB9htSfD6j3j1L1T8iWZb",
  ],
  [
    "Magic Eden M2",
    "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K",
    "2Agn3XxRf4UdWvRGwh1uYjEXUC3sSnthnGccVyrpY3pEaFemuPEDNb8AxYCbzg6tQnai4R2bdjHbJMVZfG2ennqW",
  ],
  [
    "Tensor Marketplace",
    "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp",
    "2JMd6BHt5jjFB64XKEvPP66DyrPvG6oNwyopxmAY36iC4oMbNqfhxvBxZTeAK3YUZrZEpzgJ1ftu5nUtMwGrtxnv",
  ],
  [
    "Tensor Marketplace",
    "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp",
    "48QW6n6kwr32Wrm7gX11ZZG7uZ7Y4HWa4bw5mUmuB6bmqn9d85DDoxsB8TSuzjN8V1EifkG9ZCP3UFVxgFqtmx6M",
  ],
  [
    "Phoenix",
    "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",
    "2WQtSrGHJ8ZAbT9KQ4b8283JYfY9W626rHGq6yRChKvmbmnjokwavS6cdLXNBJtEaKcx1wf7YTPi9G2ZPzjfYH1G",
  ],
  [
    "Phoenix",
    "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",
    "29uWmL2Jwbt9QSjLRXv5Kb7U53DGTQEjYj6eSZZMffVEiL9HZaqiYbj1PZtfVBc48Fy4wS6F6sFQJMywdQCtXG7P",
  ],
  [
    "Jupiter v6",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "nPsLJ87bae9fMFnLSD6wpgVnQJepkcUq5zQK2oUNe4N9TQELLboiX3WB1dkxaAXCU1QVY7DFsDPE6jRpQ5QiQhZ",
  ],
  [
    "Jupiter v6",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "2bJGJCSQg5za8xUUckHfyg3CjLUHQHE8Rvf9UGR26sxK8YQKPMGZvxA1zBNoBWYxnaKSfj2VKQXxLcPBS8v6BZFN",
  ],
  [
    "Jupiter Limit Order v2",
    "j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X",
    "RJGLC4Jsy7HMSsbUpwQ9o5RZHg3s9uCCcRnorTLPLCSdNGdGgMKBg3C855HTmf17kCvaA8YtuM6zMPnTS3rJYGF",
  ],
  [
    "Jupiter Limit Order v2",
    "j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X",
    "3haVxXtM5FZoRLkijVN2f8b3BmJnxjdFvr4D29SBGK1HZnfGN2FEycoiz1XqohpzADnriqye2vRsK87TPEGfCthU",
  ],
  [
    "OpenBook v2",
    "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb",
    "2gY6PiMjNs6C2ZucMyDhUXaBMfcYYyPhsLUXraZU9CWDRU8aTRir3jZM8bUysxPBhrZSk8ArtTY8xhs541GBGnyd",
  ],
  [
    "OpenBook v2",
    "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb",
    "4qGxbcXkMQjdXj3dGBtQ7ULUG9GT66pRktvBjvs9kHtG65fGG1qP2fx1L2ACsS4SMFcjAimzGrWLxKc3mmHeGbaS",
  ],
  [
    "Meteora DLMM",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "3gDLixGSjoHzkwzjkkbjmowXyJqwmcdnB61hf9e5fbqVzUgXPJCbzN5UQwWfg3uxMq9WDX3jMRFnj9syjVQD8uVb",
  ],
  [
    "Meteora DLMM",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "5CM9JJCdwqztMMQrmY8RfhNQstC3aNqj8ToS25mimvyoPVTUV2cFXvfjYA6ciZyBJToCuzqSN7EtYuacZr7WGBeG",
  ],
];

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const rpc = async (method: string, params: unknown): Promise<unknown> => {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (r.status === 429) {
      await sleep(2000 * (i + 1));
      continue;
    }
    const j: unknown = await r.json();
    if (j !== null && typeof j === "object" && "error" in j && j.error !== undefined) {
      if (i < 5) {
        await sleep(1500);
        continue;
      }
      throw new Error(JSON.stringify(j.error));
    }
    return j !== null && typeof j === "object" && "result" in j ? j.result : undefined;
  }
  throw new Error("rate limited");
};

const dec = getCompiledTransactionMessageDecoder();
const addr = getAddressDecoder();
const shortvec = (b: Uint8Array, o: number): [number, number] => {
  let v = 0;
  let s = 0;
  let i = 0;
  for (;;) {
    const x = b.at(o + i);
    if (x === undefined) {
      throw new Error("truncated shortvec");
    }
    // oxlint-disable-next-line eslint/no-bitwise -- shortvec LEB128 decoding
    v |= (x & 0x7f) << s;
    i++;
    // oxlint-disable-next-line eslint/no-bitwise -- shortvec LEB128 continuation bit
    if (!(x & 0x80)) {
      break;
    }
    s += 7;
  }
  return [v, i];
};

type TxResponse = {
  readonly meta:
    | {
        readonly err: unknown;
        readonly loadedAddresses?: {
          readonly writable: ReadonlyArray<string>;
          readonly readonly: ReadonlyArray<string>;
        };
      }
    | undefined;
  readonly transaction: readonly [string, string];
  readonly slot: number;
  readonly blockTime: unknown;
};

type AccountResponse = {
  readonly value: { readonly data: readonly [string, string] } | undefined;
};

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the file's own output shape
const previousEntries = JSON.parse(readFileSync(OUT, "utf8")) as Array<{ signature: string }>;
const previous = new Map(previousEntries.map((e) => [e.signature, e]));
const out: unknown[] = [];
let kept = 0;
for (const [label, program, signature] of FIXTURES) {
  let entry;
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JSON-RPC response shape
    const tx = (await rpc("getTransaction", [
      signature,
      { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    ])) as TxResponse | undefined;
    const meta = tx?.meta;
    if (
      tx === undefined ||
      meta === undefined ||
      Object.is(meta, null) ||
      !Object.is(meta.err, null)
    ) {
      throw new Error("not found");
    }
    const raw = Buffer.from(tx.transaction[0], "base64");
    const [n, len] = shortvec(raw, 0);
    const message = raw.subarray(len + 64 * n);
    const m = dec.decode(message);
    const accounts = [...m.staticAccounts];
    const lookupTables: Array<{ address: string; addresses: string[] }> = [];
    const loadedW: string[] = [];
    const loadedR: string[] = [];
    for (const l of m.addressTableLookups ?? []) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JSON-RPC response shape
      const acc = (await rpc("getAccountInfo", [l.lookupTableAddress, { encoding: "base64" }])) as
        | AccountResponse
        | undefined;
      if (acc === undefined || acc.value === undefined || Object.is(acc.value, null)) {
        throw new Error("ALT account missing");
      }
      const data = Buffer.from(acc.value.data[0], "base64");
      const addresses: string[] = [];
      for (let o = 56; o + 32 <= data.length; o += 32) {
        addresses.push(addr.decode(data.subarray(o, o + 32)));
      }
      lookupTables.push({ address: l.lookupTableAddress, addresses });
      for (const i of l.writableIndexes) {
        const a = addresses.at(i);
        if (a === undefined) {
          throw new Error("ALT index out of range");
        }
        loadedW.push(a);
      }
      for (const i of l.readonlyIndexes) {
        const a = addresses.at(i);
        if (a === undefined) {
          throw new Error("ALT index out of range");
        }
        loadedR.push(a);
      }
    }
    const la = meta.loadedAddresses ?? { writable: [], readonly: [] };
    if (
      JSON.stringify(la.writable) !== JSON.stringify(loadedW) ||
      JSON.stringify(la.readonly) !== JSON.stringify(loadedR)
    ) {
      throw new Error("ALT reconstruction mismatch");
    }
    entry = {
      label,
      program,
      executable: true,
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      signer: accounts[0],
      message: Buffer.from(message).toString("base64"),
      lookupTables,
    };
    kept++;
  } catch {
    entry = previous.get(signature);
    if (entry === undefined) {
      throw new Error(`${label} ${signature}: fetch failed and no previous entry`);
    }
    process.stderr.write(`${label} ${signature}: kept previous entry\n`);
  }
  out.push(entry);
  await sleep(150);
}
process.stderr.write(`re-fetched ${kept}/${FIXTURES.length}\n`);
writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
