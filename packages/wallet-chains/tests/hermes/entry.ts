import { secp256k1 } from "@noble/curves/secp256k1.js";
import { p2wpkh, Address, OutScript } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { NETWORK } from "@scure/btc-signer/utils.js";

/**
 * Bare-Hermes entry: runs the EVM sign vectors with no host globals. Prints HERMES_CHAINS_OK when
 * every signature matches the vector.
 */
import {
  signEvmTransaction,
  signEvmPersonalMessage,
  signEvmTypedData,
} from "@qntx/wallet-chains/evm/sign";
import { signTronMessage, signTronTransaction } from "@qntx/wallet-chains/tron/sign";

import { normalizeBitcoin } from "../../src/bitcoin/index.ts";
import { signBitcoinPsbt, signBitcoinMessage } from "../../src/bitcoin/sign.ts";
import { signSolanaMessage } from "../../src/solana/sign.ts";
import { tronAddressFromPublicKey } from "../../src/tron/index.ts";

declare function print(s: string): void;

const p2wpkhPub = (priv: Uint8Array): Uint8Array => secp256k1.getPublicKey(priv, true);

const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PERSONAL = "0x48656c6c6f20576f726c64";
const TYPED_DATA =
  '{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],"Person":[{"name":"name","type":"string"},{"name":"wallet","type":"address"}],"Mail":[{"name":"from","type":"Person"},{"name":"to","type":"Person"},{"name":"contents","type":"string"}]},"primaryType":"Mail","domain":{"name":"Ether Mail","version":"1","chainId":1,"verifyingContract":"0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"},"message":{"from":{"name":"Cow","wallet":"0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"},"to":{"name":"Bob","wallet":"0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"},"contents":"Hello, Bob!"}}';

const TRANSACTIONS = [
  {
    tx: {
      type: "legacy",
      chainId: 1,
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      data: "0x",
      value: "0x16345785d8a0000",
      nonce: 0,
      gas: "0x5208",
      gasPrice: "0x3b9aca00",
    },
    expected:
      "0xf86b80843b9aca008252089470997970c51812dc3a010c7d01b50e0d17dc79c888016345785d8a00008026a0284f42e2959657f75c4b52d96511cc6bc05c85400cb559f6184694721ec703a4a0446d5dba424fa141d9c460a58eb8cf17a86827c8525238892cc463b3f4820d0e",
  },
  {
    tx: {
      type: "eip2930",
      chainId: 1,
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      data: "0x",
      value: "0x16345785d8a0000",
      nonce: 1,
      gas: "0x5208",
      gasPrice: "0x3b9aca00",
      accessList: [
        {
          address: "0x0000000000000000000000000000000000000001",
          storageKeys: ["0x0000000000000000000000000000000000000000000000000000000000000000"],
        },
      ],
    },
    expected:
      "0x01f8a60101843b9aca008252089470997970c51812dc3a010c7d01b50e0d17dc79c888016345785d8a000080f838f7940000000000000000000000000000000000000001e1a0000000000000000000000000000000000000000000000000000000000000000001a085057187cf2122e858fa02be1e1cfcfaa19962ac2f72a700ffe88087fd8d39eea07e0ed2e9637e35b0d2c01007deb1b0d662013daac439b8ce2168144dd2da23f5",
  },
  {
    tx: {
      type: "eip1559",
      chainId: 1,
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      data: "0x",
      value: "0x16345785d8a0000",
      nonce: 2,
      gas: "0x5208",
      accessList: [],
      maxFeePerGas: "0x77359400",
      maxPriorityFeePerGas: "0x59682f00",
    },
    expected:
      "0x02f87201028459682f0084773594008252089470997970c51812dc3a010c7d01b50e0d17dc79c888016345785d8a000080c001a0ad8d9fc0a96d964860f5513a3e25ae449aaf256299cce84d4639c1ef44f30199a0445b518a2309891c5d4f1efe410d8fc1cd8ede3e2139b59d9961890ef74cd649",
  },
] as const;

const EXPECTED_PERSONAL =
  "0x65e72b1cf8e189569963750e10ccb88fe89389daeeb8b735277d59cd6885ee823eb5a6982b540f185703492dab77b863a88ce01f27e21ade8b2879c10fc9e6531c";
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

function main(): void {
  const key = hexToBytes(PRIVATE_KEY);
  for (const v of TRANSACTIONS) {
    const got = bytesToHex(signEvmTransaction(v.tx, key));
    if (got !== v.expected) {
      throw new Error(`tx ${v.tx.type} mismatch`);
    }
  }
  if (bytesToHex(signEvmPersonalMessage(hexToBytes(PERSONAL), key)) !== EXPECTED_PERSONAL) {
    throw new Error("personal-message mismatch");
  }
  if (bytesToHex(signEvmTypedData(TYPED_DATA, key)) !== EXPECTED_TYPED_DATA) {
    throw new Error("typed-data mismatch");
  }
  const solKey = hexToBytes("0x0707070707070707070707070707070707070707070707070707070707070707");
  const solMsg = hexToBytes("0x68656c6c6f20736f6c616e61");
  const solSig = signSolanaMessage(solMsg, solKey);
  const solSig2 = signSolanaMessage(solMsg, solKey);
  if (solSig.length !== 64 || bytesToHex(solSig) !== bytesToHex(solSig2)) {
    throw new Error("solana sign mismatch");
  }
  const btcKey = hexToBytes("0x1111111111111111111111111111111111111111111111111111111111111111");
  const btcPub = p2wpkhPub(btcKey);
  const btcScript = p2wpkh(btcPub, NETWORK).script;
  const prev = new Transaction({ version: 2 });
  prev.addInput({
    txid: hexToBytes(`0x${"07".repeat(32)}`),
    index: 0,
    sequence: 0xffffffff,
  });
  prev.addOutput({ script: btcScript, amount: 100000n });
  const tx = new Transaction({ version: 2 });
  tx.addInput({
    txid: hexToBytes(`0x${prev.id}`),
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: btcScript, amount: 100000n },
    nonWitnessUtxo: prev.toBytes(true, false),
    bip32Derivation: [
      [btcPub, { fingerprint: 0x73c5da0a, path: [0x80000054, 0x80000000, 0x80000000, 0, 0] }],
    ],
  });
  tx.addOutput({
    script: OutScript.encode(Address(NETWORK).decode("bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g")),
    amount: 90000n,
  });
  const req = normalizeBitcoin({
    kind: "bitcoin.psbt",
    origin: "internal",
    network: "bip122:000000000019d6689c085ae165831e93",
    account: { kind: "hd", walletId: "w", groupIndex: 0 },
    psbt: tx.toPSBT(0),
    sign: [{ index: 0, template: "btc.bip84" }],
  });
  if (req.kind !== "bitcoin.psbt") {
    throw new Error("unexpected kind");
  }
  const signed = signBitcoinPsbt(
    req.psbt,
    [{ index: 0, privateKey: btcKey }],
    () => new Uint8Array(32),
  );
  if (Transaction.fromPSBT(signed).getInput(0).partialSig === undefined) {
    throw new Error("psbt sign mismatch");
  }
  const msgSig = signBitcoinMessage(
    {
      network: "bip122:000000000019d6689c085ae165831e93",
      address: p2wpkh(btcPub, NETWORK).address,
      message: "Hello World",
      format: "bip322-simple",
    },
    btcKey,
    () => new Uint8Array(32),
  );
  if (!msgSig.startsWith("smp")) {
    throw new Error("bip322 sign mismatch");
  }
  /* vectors/chains/tron.json transactions "trx-transfer" and "trc20-transfer" plus the
     "hello-world" message — tronweb signatures for the same anvil key as the EVM rows. */
  const TRON_TRANSACTIONS = [
    {
      name: "trx-transfer",
      rawData:
        "0x0a026e5022081a2b3c4d5e6f789040e0a4eeb6b7335a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a1541f39fd6e51aad88f6f4ce6ab8827279cfffb922661215415cd0fb0ab3ce40f3051414c604b27756e69e43db18c0843d7080d0eab6b733",
      expected:
        "0xa83bcf24577a8277f8cb1f023f68831afb538b110e9784dc1a54fed0e318b8f95f3894c2c0bd3c1ef89092d91dbfb8d4d4c34a02c900c50add1caa86c0b8c80f1c",
    },
    {
      name: "trc20-transfer",
      rawData:
        "0x0a026e5022081a2b3c4d5e6f789040e0a4eeb6b7335aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a1541f39fd6e51aad88f6f4ce6ab8827279cfffb92266121541a614f803b6fd780986a42c78ec9c7f77e6ded13c2244a9059cbb0000000000000000000000005cd0fb0ab3ce40f3051414c604b27756e69e43db00000000000000000000000000000000000000000000000000000000009896807080d0eab6b73390018087a70e",
      expected:
        "0x73a32ce15fbbb48cf145e9fa7ca2f282783123f4a96bac70c724fbd5404f88445a0727b9f05012cc8a5aad735b0fe0d9a86be00b51ae424e5d46b2660248390a1c",
    },
  ];
  for (const v of TRON_TRANSACTIONS) {
    if (bytesToHex(signTronTransaction(hexToBytes(v.rawData), key)) !== v.expected) {
      throw new Error(`tron tx ${v.name} mismatch`);
    }
  }
  if (
    bytesToHex(signTronMessage(hexToBytes("0x68656c6c6f20776f726c64"), key)) !==
    "0x89ece090b6e9319ced9ade7329598e86a64852805111ce97871a4cf154b9f048506440d8b6128b37cd0353704ba7ef1748f9ab222cbd51ef46cebd27601697ef1b"
  ) {
    throw new Error("tron message mismatch");
  }
  if (
    tronAddressFromPublicKey(secp256k1.getPublicKey(key, true)) !==
    "TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG"
  ) {
    throw new Error("tron address mismatch");
  }
  print("HERMES_CHAINS_OK");
}

try {
  main();
} catch (error) {
  print(`HERMES_CHAINS_FAIL: ${error instanceof Error ? error.message : String(error)}`);
}
