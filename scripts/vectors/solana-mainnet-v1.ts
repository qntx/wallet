/// <reference types="node" />
// oxlint-disable eslint/no-await-in-loop -- requests are sequential and throttled by design
/**
 * Regenerates vectors/chains/solana-mainnet.json's v1 counterpart: real mainnet SIMD-0385
 * transactions (the 65 fixtures chosen in fixture-selection.json) used as v1 wire fixtures.
 *
 * The oracle is the public RPC https://api.mainnet-beta.solana.com: each signature is re-fetched
 * with getTransaction (encoding base64, maxSupportedTransactionVersion 1, confirmed), required to
 * be version 1 with meta.err null, split into message ‖ trailing signatures, every signature
 * verified over the message with WebCrypto Ed25519 against the first numRequiredSignatures static
 * accounts, and the message decode→encode round-trip must hold byte-for-byte. When a signature can
 * no longer be fetched or fails verification, the entry already in the output file is kept.
 *
 * Run from the repo root: bun scripts/vectors/solana-mainnet-v1.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../packages/wallet-chains/package.json", import.meta.url),
);
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the CJS require is untyped
const kit = require("@solana/transaction-messages") as {
  getCompiledTransactionMessageDecoder: () => {
    decode: (b: Uint8Array) => {
      staticAccounts: ReadonlyArray<string>;
      instructionHeaders?: ReadonlyArray<{ programAccountIndex: number }>;
      instructions?: ReadonlyArray<{
        programAddressIndex?: number;
        programAccountIndex?: number;
      }>;
    };
  };
  getCompiledTransactionMessageEncoder: () => { encode: (m: unknown) => Uint8Array };
};
const { getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder } = kit;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the CJS require is untyped
const { getAddressEncoder } = require("@solana/addresses") as {
  getAddressEncoder: () => { encode: (a: string) => Uint8Array };
};

const RPC = "https://api.mainnet-beta.solana.com";
const OUT = "vectors/chains/solana-mainnet-v1.json";
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** [label, invoked program ("TOKEN" resolves per tx), signature] — the 65 v1 fixtures. */
const FIXTURES: ReadonlyArray<readonly [string, string, string]> = [
  [
    "Jupiter v6",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "3X5euhSmPCxS8L9dSjVK7vbXQthcCPGDNEnUeXxkTxMnE2Qxni3efrAv2PSwtw9NpJLurZYXQ1VtiusiLaN6eEdL",
  ],
  [
    "Jupiter v6",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "3wgXzK72FxzXFMBekbYRscK9L7fvBr73YTrQpS3ya2cc2MKaAMSxFecZMATyYAUxByG6veuUXguSvAgosNrj6SQ5",
  ],
  [
    "Jupiter v6",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "62kKB7BgofdNK1cH6H57iTu6BcPvenLCLZuAZ2Hu5kX4viP2JsApVrit8fSRoZDsBQGwiydy3E4M7o9cUakUU3Pz",
  ],
  [
    "Jupiter v6",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "5f1Dbr21TR3FJiSXFBRHT2RwtEP75tP281pVreMckb1xZL5xGxpwycEgk6qPyJDjj9yffN7U5vbX4V1afy3o4rem",
  ],
  [
    "Jupiter v6",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "53Nq8oaVJUcvUFx2kWagWPkw125eWBk2pVtGfvRiAZMZXgUivMyaDXpcyj5GGdtWzrDimpFCsx3jCv3r9haCvdBP",
  ],
  [
    "Jupiter v6",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "2Wnu3P1gfqChVSVfcRr64tGqjt5o62uae2uhc2BFZddhBWuAZTLKwVNdDV6Y4Hw9srpLnr3WWd7wxkLmzo4DVyzy",
  ],
  [
    "Jupiter v6",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "2oF5vevN8b5gfAySFENYDKctPN4ULq87b14oA5NzcTbhnhauk25YG3x2bQ9Uyr6sZu75sYtP6YHhsvLqsSRAzTxx",
  ],
  [
    "Jupiter v6",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "3sVTumCTiqPmntuJDmeRaKzbFxYQn15hXivM2pJRKDoYJHhh6p3mngADWgzjP876CwQu6r7T1R5DwuPV5AvCJGvo",
  ],
  [
    "Kamino Lend",
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
    "2RNo96BfYs5Q3s5QxZqvHbWmfNz7rt9b6vaSY1ds1cZPWMgZQUwzn3nAshoaRHY15T86SddNkb3F3CQiCX4B9QzY",
  ],
  [
    "Kamino Lend",
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
    "2jJuqFuVViAyCLiARyt8FLYChda6PCaxUnJ1rnHGxNmpLEZvWaKAESAja86dnZsZyM7bH9UGhEPCD79t7E6WrUVG",
  ],
  [
    "Kamino Lend",
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
    "4MjTrBc8fdkk3Pjv3rR6vjUMsnF6cvoMNZJddGtHw1KNw7axpUrKN7LHKbE4LfSYnyhE6xbSo9y1QzJMG7PGvoet",
  ],
  [
    "Kamino Lend",
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
    "4q15K1b8EBDaum1rjf31D3FpBX8n5xfe6betN11VBQch31aCXngdvBQNUx1F6oebQkj11rufUQjUsDMG2j7ae7Ca",
  ],
  [
    "Kamino Lend",
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
    "rmVsH2VDYgUWWBLZ4QMRvDR6r5CDjZPx1yvB37n59bisW3AQrHZ8DwAFwaWMew4sVWQqycrTAXAgSWFq2uvJJNd",
  ],
  [
    "Kamino Lend",
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
    "J2DjHQz8jJwRroqX4gKASv34qiQMpQiY1nGZ95Y8jyy8eqRhEdvHPRerPxEaQ5PNPBmHbxac8EtCAqvYADmNoQQ",
  ],
  [
    "Kamino Lend",
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
    "5rU6C5WKuRAgdU7GzZwbooNvD3CF6T8aEAK8qqPtW6QqeBgPiXFRY28Ydn66CgH6QGMaKfbQRRd1bekUYKNsZmjM",
  ],
  [
    "Kamino Lend",
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
    "j5cFikxdptMJ7AURmcFvpgiB3qahgZvGNAQzpWNYM6vAGwNV8mBZLvXJpbfyoVJcqcHLAdimUZeXjFQ6R5hTbje",
  ],
  [
    "Meteora DAMM v2",
    "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
    "4zzuLeMzkWcqpe7pqkzyoEjkotDbd5kHjChXgebABMZaiArkZu9nmWDTrsG1qZ3GQ84sGTGHKhPaisZU9zFVXUtw",
  ],
  [
    "Meteora DAMM v2",
    "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
    "55gF1T1Hz7juUAdQWVorokeToTxweg9FdPwbR1efpwMdsnDsvzSrMj7oeMoQgN6L6TXJvX6QGeYoZsyeL3F6MUqi",
  ],
  [
    "Meteora DAMM v2",
    "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
    "bPqejmqAVAq81DG7VTSZHsKz9z4fwquijNs8qhyQCQGi4LkxAFzP6GcdWc4NYwHtms9q5NJMFwgCzojpRzPMh8y",
  ],
  [
    "Meteora DLMM",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "2X2xZX1H312kLMDt1cTUTupL1ndix2M6hx4Dp29UYw4X5FQc5xfzydw5duKdZMAKwrF3noPiPH1oFB6uN2coADiY",
  ],
  [
    "Meteora DLMM",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "5wCdMtdgkyzKrc2gMxxgxxn6C6WSt4DBeM6i2bjYzBu3C8fWDRR5tUcG4a7KJi37kzV9C43DTwhpTfGZXzvtyAii",
  ],
  [
    "Meteora DLMM",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "51vNNCZ67Eju8jJdtCRLDbvvX3JG5arcxKoHqHNCHSm2zQ7oobaZYneQSHYWoinzwE6k1oGmCMrWtRVZSm7xWnE",
  ],
  [
    "Meteora DLMM",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "4Y3LKDtTgPt2ST19pEeHqq7UtfA28jT8xaVyc6PdchTBiTQL3i9VkMK2tNXaMgvcmj5eKytcbPLGQmqcBsRnzxTo",
  ],
  [
    "Meteora DLMM",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "55y5mJhkmXUQHhTyaFwXh47MjMmDLAeQmaWgJLTnKEQbBjXA4JF3ugiiEL5gHdgXxnooHtk46FDBNxct9FcoVtnB",
  ],
  [
    "Meteora DLMM",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "49j71Ahiy7QvsBQSf3EQmKpbunb2EB3dACvPsQJ2epjTcSaj6296gr4HVqrLK8QQGDgsWmn2LAfN52z5mbohZi3A",
  ],
  [
    "Meteora DLMM",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "5a9fTyMeBs6XQi2jRoBcW9CkhTenqNPhfqkSPUCatzFH92gzdQQtZfKi1126m28f8bKr5pSaDYp4MVTdHwa9SL4c",
  ],
  [
    "Meteora DLMM",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "2EEJLYSnx9CWC4tuENTQqwRc3u3QpndoLRkDDcyxzbJkmqgVmsSsZfDPceLFRJpfjFFdFniHhabNmaWSY5NFuoXe",
  ],
  [
    "Orca Whirlpool",
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    "4HBYwnrLESMJgPY1JyaDYxzMYKtYVVb3veXFDyCxTsigJRHft9j3GqHyBeW4vvLBvEiTY1YbocKR7YjKfDwSU8M4",
  ],
  [
    "Orca Whirlpool",
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    "2KmXabZeZyakA65MJjBEq3Wye8jEsyxB9DqGgSwvWvdiwyyCSgrsV1V5N2kimepFVkJEsbbydTnn6DUDBJ9EGjD2",
  ],
  [
    "Orca Whirlpool",
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    "ofUrFSwLWzieYfMMu4yZyiHp1fhcbehyJKVKw88p3nFpWVheh544bkDQN1WZuVsa9cHyf7NBW4Pz7AQvBVyjabT",
  ],
  [
    "Phoenix",
    "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",
    "2Dqi3M1jtjoeHMGXYEW55fiFD9EJnW8GbDYtxGHNcj5Hdnqo2DGPprLHVhE7CZDPJYXgzHN6uR2Jw19vD7rUy8Lg",
  ],
  [
    "Phoenix",
    "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",
    "2EGtis4RkHdX8cQ6QXRCghnymMqLzg4QdGng9cXiCAWWF4YQznjTD5oAExVdpUhxaYbTAKR2rE5TUbP7kzkJiVy",
  ],
  [
    "Pump.fun",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "4y6xE2p9Ymag7BmtqhE7JexWvNPquq68cb1cLmZckC9EKJEDTA7aZTUZksqgQaLL4oF2rz5e8p4zLKa7Jo1LpNaE",
  ],
  [
    "Pump.fun",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "28uyToH6FaQB8exprujySuKmtQ7Wro3SJbTw2nr8K1Uk8Fbdc2bhGpZdyhmgUVuFZ621VyMCnnnBDGcF3KVfdoej",
  ],
  [
    "Pump.fun",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "5DDqX6uJBLzMPjje5Xwv25zANHBhySNvw3rX1x1tazNGDhDpw5DUhd66QFKofJVUKZpv4XNg42uCcjW8JFohnySv",
  ],
  [
    "Pump.fun",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "3rfwnRSJwJ8eP6M81nGvKfbkUuSyroXiNCjEoR7sLY2m9weKLtzXj4XN1DqVCpEYTBNcSCRm8Wdv8dMjVT6eh56f",
  ],
  [
    "Pump.fun",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "5ScAJqkKaLHgCzBkT93czYQZfLfzsu3ydb2zTwrg4vgSuWKpJtPgVhmc6Qg3u4Jbvin6rmpQEoTNeL2LkeWPWnuZ",
  ],
  [
    "Pump.fun",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "hTGRasDpt9wMsxDnn98dtLJnuqfxbtUZMwDGMPUdoW47n7ADbVT9xmdRQVGEyb4ST2sH3fs8qatDEnbdQygEan1",
  ],
  [
    "Pump.fun",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "2sWxMuUXAZdg4Ww9svnC5TMtH9bcDauLicfR6hjEw1u8Xq87DAbGELnuR7KduceWw3aj5J2iKuXkjhBwE7Fb9nek",
  ],
  [
    "Pump.fun",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "2tdbtvkTajtJgBY7PBU8MB4N727fy6o3ridh8BusJeF2LbtQLCtDft4PoKjFvHMM69CwCCWUMUhZywUk6CTusggZ",
  ],
  [
    "PumpSwap",
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    "2hQTkCe7vFv3tSc3j1uSZmuie53YgspeLfBQNQQDi3SuRrYeZAHg5kCgDrMmeN8pQxwksTpBQyghn8b8Rdu6w4VC",
  ],
  [
    "PumpSwap",
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    "2iY4kvAe6hSTabv1PCM1MhadTJTNWZwpcseg6uHtzrsLoxNyLwdR6WoaAndDCjHAzvv59iEdD1AnP6VbBcRA8oKJ",
  ],
  [
    "PumpSwap",
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    "2wnmUc62VdAqpULx27K29DahxkiuX5vGrd1NnhpogoXtw9AM2XtQXLuNF9YwJWdhMFcVyR5oWjkusUDRLh3NWpyi",
  ],
  [
    "PumpSwap",
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    "Bvp3wQAPtG6Rf3Skf9SdCnYBpP85okYx8VYaXToLJCv3Z5jctKjG4hPMoQZpENRykDYSCBy3GQhbgP2zMNwiZYV",
  ],
  [
    "PumpSwap",
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    "5hZAA6Y6RXjaRcFS6PtUSHuyMFy1tUf8FepSKNrmPVBajNp9j9kbeereXYcjbEMDUcqwHhp5oWt2XY6opqqUMpTw",
  ],
  [
    "Raydium AMM v4",
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    "3KkxDQX7nueYGJLh7atnsjkGbRQUFV6uRbWTQnAmR5TYn6wCW4zTgVjALWRCqbt8woLVLhDQ2LgCh2sHnYooo2be",
  ],
  [
    "SPL TransferChecked",
    "TOKEN",
    "3JZ5oW7ca5RJhEsjSEFXug24GMPekEfU7Uz35wt2SuQCk9tDPYNPobiKzcFm7nb15ppCN9dqShcnD2w3ozeMLYPR",
  ],
  [
    "SPL TransferChecked",
    "TOKEN",
    "5QnyCGPuYFDN39iLm3cv3LZLCXUtwmU6EQyoT3GpNdS31qFeT1zey6nrBtJTUTMBSmTF9iMgbYo83qe242X5KrMG",
  ],
  [
    "SPL TransferChecked",
    "TOKEN",
    "4xP6N63wAbcQv6ifoxZGH222xkCwh5Dg8f1ZGjQZYxiNxmrzMqVw7LWLwNnLs3AiKPSApfBYwWaKnUcFZGzwtMip",
  ],
  [
    "SPL TransferChecked",
    "TOKEN",
    "5hbuYGwLzkn2LUGFm6MZ5WCZTKjBwZGuUakf2sXejcMzfZoDhEQd5jGN7M5BZagz8gGy2caP6WWRrbmCWWxyvHDg",
  ],
  [
    "SPL TransferChecked",
    "TOKEN",
    "5EVqGFKArX91AR8Q1K3mt25rSwzp3A5kAUUC5wJLEQjG48urdyzmCxgQeWgvH2uJEfphxDux6tAQRjYsyhzKyDC",
  ],
  [
    "SPL TransferChecked",
    "TOKEN",
    "5fARW4U8Uji2nWodvRPyzeJ9oEtZwvNcKrvoNxuVvUctgAGAjzrG9Gbwh5NBKjnkGSw1LcPwrazNKn2GmVt8CcYJ",
  ],
  [
    "SPL TransferChecked",
    "TOKEN",
    "3L8tikddUG7dAgJR9yUthyvCy6jUUHv5g3MVMm72FyemnNJocpyD8mSzfrf3c6iksT5FDQ6Ueq1B8g8iwocCe3JF",
  ],
  [
    "SPL TransferChecked",
    "TOKEN",
    "317KNqAbQqWuzaJUU2FL3tQnMZ4Un7aThSaJfbvY8dgtBcXwdsrhtwYgL294TsKq7rkuKUKWSVfJLMEvgpJfFbHi",
  ],
  [
    "Tensor Marketplace",
    "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp",
    "zJjDPifKFhvqQuVMkJAwdRNV83vQnrNc2oX739142mg1a32wuQBSequnxUn4beWja3Kcc24r4Pv6Rsrccu1Qpca",
  ],
  [
    "Tensor Marketplace",
    "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp",
    "5DmAHbQVwG3XWCuHNeFxyMGztZLakXninsbT15deMxFuP9qBhRR56saMCrAMfstGq94r8zc1GJSZt7q2EbqZpo5",
  ],
  [
    "Tensor Marketplace",
    "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp",
    "tRvy6EXT8BphXY3ZAjrXCBBACuZUZpEwE78iTnUqagQnZwXZAqk3kjdtS4NFnf1qhiDgQN5Zr54HGbjNeUatJEJ",
  ],
  [
    "marginfi v2",
    "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    "NoP7PF3ZgHqadoedBm1gyU8xAZeKbpzhWXcE6DRgo9tZdePixoqVYvD4QekF3q5cgYAPDGxoWstpaCfjihPdgdg",
  ],
  [
    "marginfi v2",
    "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    "5HTDTkMYKhQ9TrSZZWvZ3fPC6LPXgq8pnAMHZLBgF4HKoB16ifepQDsUvZXG9R8pQJwW9Akc1Yqcn4VpMkMC7g43",
  ],
  [
    "marginfi v2",
    "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    "2awcc9C23WX1jqyuiHN2MkwF9dchjr44KXDZgbe1phoPcxNgJNeAYqesZiSzt6PEjqXaqfPfJ7zrv1GUcVoSRUCu",
  ],
  [
    "marginfi v2",
    "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    "4pSKeFqdQTqCuQXMiGZXGizUAKjHg8eGNeDek2tVGP2AoCojBSx8E3WrwCUitagGZ8TA4StjhsfTSoFqwsMWAacw",
  ],
  [
    "marginfi v2",
    "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    "3SZ2kfpKKErkC63Tsge3kemJKZdxu4Nv9jAGeSxEcQTt1e5cdtQxyGJZcbBNViRhMM2h1YAELPJoWTkuNbLBWhs5",
  ],
  [
    "marginfi v2",
    "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    "fLKcrZU4GpPMSD6AGtSGJRocYf5eVU9Hj2kp8YPwxHc2kBUBgeCX7UCvbMrxN5VD8fsHfXHZRNMasStK82ii9j8",
  ],
  [
    "marginfi v2",
    "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    "pezvE8uqgvJvMaVFwLroBfFaAYoeZYYCi1pWQ2RBbaNHCDyDSQhVgP4Z1prvJ2tKAVTteHi1HBrNhJw26eqsed2",
  ],
  [
    "marginfi v2",
    "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    "2s9YdjoTJcGc3C8XcZ1kKfctioo5q5niEDRVC8NEMinViqzjya8BzkscVAxgGrHTKsud4eJMrZ6UkF6erugjSNS9",
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

type TxResponse = {
  readonly meta: { readonly err: unknown } | undefined;
  readonly transaction: readonly [string, string];
  readonly slot: number;
  readonly blockTime: unknown;
  readonly version: unknown;
};

const dec = getCompiledTransactionMessageDecoder();
const enc = getCompiledTransactionMessageEncoder();
const addr = getAddressEncoder();

/** WebCrypto Ed25519 verify — an oracle independent of the wallet's noble path. */
const verify = async (pub: string, sig: Uint8Array, msg: Uint8Array): Promise<boolean> => {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(addr.encode(pub)),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("Ed25519", key, Buffer.from(sig), Buffer.from(msg));
};

/** The token program an "SPL TransferChecked" fixture actually invokes. */
const tokenProgram = (m: {
  staticAccounts: ReadonlyArray<string>;
  instructionHeaders?: ReadonlyArray<{ programAccountIndex: number }>;
  instructions?: ReadonlyArray<{ programAddressIndex?: number; programAccountIndex?: number }>;
}): string => {
  const programs = new Set<string>();
  for (const h of m.instructionHeaders ?? []) {
    const p = m.staticAccounts[h.programAccountIndex];
    if (p !== undefined) {
      programs.add(p);
    }
  }
  for (const ix of m.instructions ?? []) {
    const idx = ix.programAccountIndex ?? ix.programAddressIndex;
    const p = idx === undefined ? undefined : m.staticAccounts[idx];
    if (p !== undefined) {
      programs.add(p);
    }
  }
  if (programs.has(TOKEN_2022)) {
    return TOKEN_2022;
  }
  return programs.has(SPL_TOKEN) ? SPL_TOKEN : SPL_TOKEN;
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
      { encoding: "base64", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
    ])) as TxResponse | undefined;
    const meta = tx?.meta;
    if (
      tx === undefined ||
      meta === undefined ||
      Object.is(meta, null) ||
      !Object.is(meta.err, null) ||
      tx.version !== 1
    ) {
      throw new Error("not found");
    }
    const raw = Buffer.from(tx.transaction[0], "base64");
    if (raw[0] !== 0x81) {
      throw new Error("not a v1 wire");
    }
    const requiredSigs = raw[1] ?? 0;
    const message = raw.subarray(0, raw.length - 64 * requiredSigs);
    const signatures = raw.subarray(raw.length - 64 * requiredSigs);
    if (raw.length - 64 * requiredSigs <= 0) {
      throw new Error("signature block overlaps the message");
    }
    const m = dec.decode(message);
    const reencoded = new Uint8Array(enc.encode(m));
    if (!Buffer.from(reencoded).equals(Buffer.from(message))) {
      throw new Error("kit message round-trip mismatch");
    }
    const accounts = [...m.staticAccounts];
    for (let i = 0; i < requiredSigs; i++) {
      const pub = accounts[i];
      const sig = signatures.subarray(64 * i, 64 * (i + 1));
      if (pub === undefined || sig.length !== 64) {
        throw new Error("signature block shorter than the header claims");
      }
      if (!(await verify(pub, sig, message))) {
        throw new Error(`signature ${i} does not verify`);
      }
    }
    entry = {
      label,
      program: program === "TOKEN" ? tokenProgram(m) : program,
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      signer: accounts[0],
      wire: raw.toString("base64"),
    };
    kept++;
  } catch (error) {
    entry = previous.get(signature);
    if (entry === undefined) {
      throw new Error(`${label} ${signature}: ${String(error)} and no previous entry`, {
        cause: error,
      });
    }
    process.stderr.write(`${label} ${signature}: kept previous entry (${String(error)})\n`);
  }
  out.push(entry);
  await sleep(150);
}
process.stderr.write(`re-fetched ${kept}/${FIXTURES.length}\n`);
writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
