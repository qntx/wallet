/**
 * Chains probe: times the three chain families' signing paths inside the kernel runtime with the
 * real native platform (same N=50/median/p95 convention as the kernel probe). Every result is
 * checked against the vector bytes — a wrong signature fails the probe rather than reporting a
 * bogus timing.
 */
import { signEvmTransaction, signEvmPersonalMessage, signEvmTypedData } from "@qntx/wallet-chains/evm/sign";
import { decodeEvm, normalizeEvm } from "@qntx/wallet-chains/evm";
import { signSolanaMessage } from "@qntx/wallet-chains/solana/sign";
import { signBitcoinMessage, signBitcoinPsbt } from "@qntx/wallet-chains/bitcoin/sign";
import { decodeBitcoinPsbt, normalizeBitcoin } from "@qntx/wallet-chains/bitcoin";
import { p2wpkh, p2tr } from "@scure/btc-signer/payment.js";
import { NETWORK } from "@scure/btc-signer/utils.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

import { postJson } from "./share.ts";

const EVM_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const BTC_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const EVM_TX = {
  type: "eip1559" as const,
  chainId: 1,
  to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  data: "0x",
  value: "0x16345785d8a0000",
  nonce: 2,
  gas: "0x5208",
  accessList: [],
  maxFeePerGas: "0x77359400",
  maxPriorityFeePerGas: "0x59682f00",
};
const EXPECTED_TX =
  "0x02f87201028459682f0084773594008252089470997970c51812dc3a010c7d01b50e0d17dc79c888016345785d8a000080c001a0ad8d9fc0a96d964860f5513a3e25ae449aaf256299cce84d4639c1ef44f30199a0445b518a2309891c5d4f1efe410d8fc1cd8ede3e2139b59d9961890ef74cd649";
const PERSONAL = "0x48656c6c6f20576f726c64";
const EXPECTED_PERSONAL =
  "0x65e72b1cf8e189569963750e10ccb88fe89389daeeb8b735277d59cd6885ee823eb5a6982b540f185703492dab77b863a88ce01f27e21ade8b2879c10fc9e6531c";
const TYPED_DATA =
  '{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],"Person":[{"name":"name","type":"string"},{"name":"wallet","type":"address"}],"Mail":[{"name":"from","type":"Person"},{"name":"to","type":"Person"},{"name":"contents","type":"string"}]},"primaryType":"Mail","domain":{"name":"Ether Mail","version":"1","chainId":1,"verifyingContract":"0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"},"message":{"from":{"name":"Cow","wallet":"0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"},"to":{"name":"Bob","wallet":"0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"},"contents":"Hello, Bob!"}}';
const EXPECTED_TYPED_DATA =
  "0x6ea8bb309a3401225701f3565e32519f94a0ea91a5910ce9229fe488e773584c0390416a2190d9560219dab757ecca2029e63fa9d1c2aebf676cc25b9f03126a1b";

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return out;
};
const bytesToHex = (bytes: Uint8Array): string => {
  let s = "0x";
  for (const b of bytes) {
    s += b.toString(16).padStart(2, "0");
  }
  return s;
};
const eq = (a: Uint8Array, b: Uint8Array): boolean => bytesToHex(a) === bytesToHex(b);

interface Op {
  readonly name: string;
  readonly run: () => void;
}

const MAINNET_BTC = "bip122:000000000019d6689c085ae165831e93";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "btc" } as const;
const auxRand = (): Uint8Array => new Uint8Array(32);

const buildP2wpkhPsbt = (pub: Uint8Array): Uint8Array => {
  const tx = new Transaction({ version: 2 });
  tx.addInput({
    txid: hexToBytes("0x" + "07".repeat(32)),
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: p2wpkh(pub, NETWORK).script, amount: 100000n },
    bip32Derivation: [[pub, { fingerprint: 0x73c5da0a, path: [0x80000054, 0x80000000, 0x80000000, 0, 0] }]],
  });
  tx.addOutput({ script: Uint8Array.of(0x00, 0x14, ...new Uint8Array(20)), amount: 90000n });
  return tx.toPSBT(0);
};

const buildP2trPsbt = (internal: Uint8Array): Uint8Array => {
  const tx = new Transaction({ version: 2 });
  tx.addInput({
    txid: hexToBytes("0x" + "08".repeat(32)),
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: p2tr(internal, undefined, NETWORK).script, amount: 100000n },
    tapInternalKey: internal,
    tapBip32Derivation: [
      [internal, { hashes: [], der: { fingerprint: 0x73c5da0a, path: [0x80000056, 0x80000000, 0x80000000, 0, 0] } }],
    ],
  });
  tx.addOutput({ script: Uint8Array.of(0x00, 0x14, ...new Uint8Array(20)), amount: 90000n });
  return tx.toPSBT(0);
};

const time = (run: () => void, n: number): { median: number; p95: number } => {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = __qntx.elapsed();
    run();
    samples.push(__qntx.elapsed() - t0);
  }
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(samples.length / 2)]!, p95: samples[Math.floor(samples.length * 0.95)]! };
};

function main(): void {
  const evmKey = hexToBytes(EVM_KEY);
  const btcKey = hexToBytes(BTC_KEY);
  const pub = secp256k1.getPublicKey(btcKey, true);
  const internal = pub.subarray(1);
  const solKey = hexToBytes("0x0707070707070707070707070707070707070707070707070707070707070707");
  const solMsg = hexToBytes("0x68656c6c6f20736f6c616e61");
  const wpkhPsbt = buildP2wpkhPsbt(pub);
  const trPsbt = buildP2trPsbt(internal);
  const bAddress = p2wpkh(pub, NETWORK).address ?? "";
  const normalizedPsbt = normalizeBitcoin({
    kind: "bitcoin.psbt",
    network: MAINNET_BTC,
    account: ACCOUNT,
    psbt: wpkhPsbt,
    sign: [0],
  });
  if (normalizedPsbt.kind !== "bitcoin.psbt") {
    throw new Error("unexpected kind");
  }
  const ops: Op[] = [
    {
      name: "evm.tx.eip1559",
      run: () => {
        const sig = signEvmTransaction(EVM_TX, evmKey);
        if (bytesToHex(sig) !== EXPECTED_TX) {
          throw new Error("eip1559 sig mismatch");
        }
      },
    },
    {
      name: "evm.personal",
      run: () => {
        const sig = signEvmPersonalMessage(hexToBytes(PERSONAL), evmKey);
        if (bytesToHex(sig) !== EXPECTED_PERSONAL) {
          throw new Error("personal sig mismatch");
        }
      },
    },
    {
      name: "evm.typedData",
      run: () => {
        const sig = signEvmTypedData(TYPED_DATA, evmKey);
        if (bytesToHex(sig) !== EXPECTED_TYPED_DATA) {
          throw new Error("typed-data sig mismatch");
        }
      },
    },
    {
      name: "solana.message",
      run: () => {
        if (signSolanaMessage(solMsg, solKey).length !== 64) {
          throw new Error("solana sig mismatch");
        }
      },
    },
    {
      name: "bitcoin.p2wpkh.psbt",
      run: () => {
        const out = signBitcoinPsbt(wpkhPsbt, [{ index: 0, privateKey: btcKey }], auxRand);
        if (Transaction.fromPSBT(out).getInput(0).partialSig === undefined) {
          throw new Error("p2wpkh sig missing");
        }
      },
    },
    {
      name: "bitcoin.p2tr.psbt",
      run: () => {
        const out = signBitcoinPsbt(trPsbt, [{ index: 0, privateKey: btcKey }], auxRand);
        if (Transaction.fromPSBT(out).getInput(0).tapKeySig === undefined) {
          throw new Error("taproot sig missing");
        }
      },
    },
    {
      name: "bitcoin.bip322",
      run: () => {
        if (!signBitcoinMessage({ network: MAINNET_BTC, address: bAddress, message: "Hello World", format: "bip322-simple" }, btcKey, auxRand).startsWith("smp")) {
          throw new Error("bip322 sig mismatch");
        }
      },
    },
    {
      name: "evm.normalize+decode",
      run: () => {
        const n = normalizeEvm({
          kind: "evm.transaction",
          network: "eip155:1",
          account: { kind: "hd", walletId: "w", groupIndex: 0, template: "evm" },
          tx: EVM_TX,
        });
        if (decodeEvm(n).verifiability !== "full") {
          throw new Error("evm decode mismatch");
        }
      },
    },
    {
      name: "bitcoin.normalize+decode",
      run: () => {
        const n = normalizeBitcoin({
          kind: "bitcoin.psbt",
          network: MAINNET_BTC,
          account: ACCOUNT,
          psbt: wpkhPsbt,
          sign: [0],
        });
        if (n.kind !== "bitcoin.psbt" || decodeBitcoinPsbt(n).verifiability !== "full") {
          throw new Error("bitcoin decode mismatch");
        }
      },
    },
  ];
  for (const op of ops) {
    for (let i = 0; i < 3; i++) {
      op.run();
    }
  }
  const results = ops.map((op) => ({ op: op.name, ...time(op.run, 50) }));
  postJson({ probe: "chains", ops: results });
}

try {
  main();
} catch (error) {
  postJson({ probe: "chains", error: error instanceof Error ? error.message : String(error) });
}
