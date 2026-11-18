/**
 * R3 review proof-of-concept tests: every `POC Fx:` test asserts the CURRENT behaviour, so it
 * passes today and fails once the finding is fixed. They must not be "fixed" by editing them —
 * a failure after a product change is the intended signal.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58, base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import { checksumEvmAddress, decodeEvm, normalizeEvm } from "@qntx/wallet-chains/evm";
import { normalizeSolana } from "@qntx/wallet-chains/solana";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { chainPrompt } from "../src/modules/chains/prompt.ts";
import type { PasskeyAuthenticator } from "../src/platform.ts";
import type { KeystorePrompt } from "../src/platform.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DEVICE = { kind: "device" } as const;
const HARDWARE = { kind: "hardware" } as const;
const SAFE = checksumEvmAddress("0xd5ffe748b45f5253fc9975fdd96fddec052e6d52");
const SOL_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF_VAULT = new Uint8Array(32).fill(0x11);
const PRF_WALLET = new Uint8Array(32).fill(0x22);

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}

function errCode(response: KernelResponse): string | undefined {
  return "err" in response ? response.err.code : undefined;
}

function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  const v = value[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
}

const strField = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};

const prompts = (calls: ReadonlyArray<KeystoreCall>, op: "seal" | "open"): KeystorePrompt[] =>
  calls.flatMap((call) => (call.op === op && call.prompt !== undefined ? [call.prompt] : []));

const zeroed = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0);

async function importHardware(h: Harness): Promise<{ session: string; walletId: string }> {
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE }),
  );
  return {
    session: strField(res, "session"),
    walletId: strField(field(res, "wallet"), "walletId"),
  };
}

const solAddress = async (h: Harness, session: string, walletId: string): Promise<string> =>
  strField(
    ok(
      await h.call(
        "wallet.accounts",
        {
          walletId,
          groupIndex: 0,
          template: "solana.bip44-change",
          network: SOL_NETWORK,
        },
        session,
      ),
    ),
    "address",
  );

/* ------------------------------------------------------------------ Solana */

const SRC_TOKEN = base58.decode("LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY");
const DST_TOKEN = base58.decode("QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF");
const USER_ATA = base58.decode("CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8");
const ATTACKER = base58.decode("8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR");
const TOKEN_PROGRAM = base58.decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const BLOCKHASH = new Uint8Array(32);

const u64le = (n: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};

/** A hand-rolled legacy compiled message: header, account keys, blockhash, instructions. */
const compile = (
  header: readonly [number, number, number],
  keys: ReadonlyArray<Uint8Array>,
  ixs: ReadonlyArray<{
    program: number;
    accounts: ReadonlyArray<number>;
    data: Uint8Array;
  }>,
): Uint8Array => {
  const parts: Uint8Array[] = [
    new Uint8Array(header),
    new Uint8Array([keys.length]),
    ...keys,
    BLOCKHASH,
    new Uint8Array([ixs.length]),
  ];
  for (const ix of ixs) {
    parts.push(
      new Uint8Array([ix.program]),
      new Uint8Array([ix.accounts.length]),
      new Uint8Array(ix.accounts),
      new Uint8Array([ix.data.length]),
      ix.data,
    );
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

/** SPL Token `Transfer` (tag 3): [source(w), destination(w), owner(signer)]. */
const splTransfer = (signer: string) =>
  compile(
    [1, 0, 1],
    [base58.decode(signer), SRC_TOKEN, DST_TOKEN, TOKEN_PROGRAM],
    [
      {
        program: 3,
        accounts: [1, 2, 0],
        data: new Uint8Array([3, ...u64le(1_000_000n)]),
      },
    ],
  );

/** SPL Token `SetAuthority` AccountOwner (tag 6): [owned(w), owner(signer)]. */
const splSetAuthority = (signer: string) =>
  compile(
    [1, 0, 1],
    [base58.decode(signer), USER_ATA, TOKEN_PROGRAM],
    [
      {
        program: 2,
        accounts: [1, 0],
        data: new Uint8Array([6, 2, 1, ...ATTACKER]),
      },
    ],
  );

const solTxRequest = (walletId: string, signer: string, message: Uint8Array) =>
  normalizeSolana(
    {
      kind: "solana.transaction",
      network: SOL_NETWORK,
      account: {
        kind: "hd",
        walletId,
        groupIndex: 0,
        template: "solana.bip44-change",
      },
      message,
    },
    signer,
  );

/* ------------------------------------------------------------- SafeMessage */

const RAW_HASH = bytesToHex(keccak_256(utf8ToBytes("permit2 digest")));
const safeMessageDoc = {
  types: {
    EIP712Domain: [
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    SafeMessage: [{ name: "message", type: "bytes" }],
  },
  primaryType: "SafeMessage",
  domain: { chainId: 1, verifyingContract: SAFE },
  message: { message: `0x${RAW_HASH}` },
};

const typedDoc = (walletId: string, doc: unknown) =>
  normalizeEvm({
    kind: "evm.typed-data",
    network: "eip155:1",
    account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
    typedData: JSON.stringify(doc),
  });

describe("POC F1: a SafeMessage wrapping a raw hash signs with blind signing off", () => {
  it("POC F1: chain.sign returns a signature and the prompt shows the raw hex", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await importHardware(h);
    const request = typedDoc(walletId, safeMessageDoc);
    const response = await h.call("chain.sign", { request, verify: HARDWARE }, session);
    expect(errCode(response)).toBeUndefined();
    expect("ok" in response).toBe(true);
    const prompt = prompts(fake.calls, "open").at(-1);
    expect(prompt?.description).toContain(`0x${RAW_HASH}`);
  });
});

describe("POC F2: opaque core-program Solana instructions sign with blind signing off", () => {
  it.each([
    ["SPL Token Transfer (tag 3)", splTransfer],
    ["SPL Token SetAuthority/AccountOwner (tag 6)", splSetAuthority],
  ] as const)("POC F2: %s returns a signature", async (_name, build) => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await importHardware(h);
    const signer = await solAddress(h, session, walletId);
    const request = solTxRequest(walletId, signer, build(signer));
    const response = await h.call("chain.sign", { request, verify: HARDWARE }, session);
    expect(errCode(response)).toBeUndefined();
    expect("ok" in response).toBe(true);
  });
});

describe("POC F6: backup.enable leaks factor secrets when verification fails", () => {
  it("POC F6: a wrong verify factor errors before params.factors are wiped", async () => {
    const h = createHarness();
    await h.settle();
    const res = ok(
      await h.call("wallet.createWithPasskey", {
        ceremony: "host",
        credentialId: new Uint8Array(CREDENTIAL_ID),
        prfWallet: new Uint8Array(PRF_WALLET),
        synced: true,
        factor: { kind: "passkey", credentialId: new Uint8Array(CREDENTIAL_ID), prf: new Uint8Array(PRF_VAULT) },
      }),
    );
    const session = strField(res, "session");
    const passwordBuf = utf8ToBytes("backup-pw-1234567890");
    const prfBuf = new Uint8Array(32).fill(0x33);
    const wrongVerify = {
      kind: "passkey" as const,
      credentialId: new Uint8Array(CREDENTIAL_ID),
      prf: new Uint8Array(32).fill(0x99),
    };
    const response = await h.call(
      "backup.enable",
      {
        verify: wrongVerify,
        factors: [
          { kind: "password", password: passwordBuf },
          {
            kind: "passkey",
            ceremony: "host",
            credentialId: new Uint8Array(CREDENTIAL_ID),
            prfBackup: prfBuf,
          },
        ],
      },
      session,
    );
    expect(errCode(response)).toBe("wrong-passkey");
    // Vulnerable: the try/finally that wipes params.factors never ran — the secrets survive.
    expect(zeroed(passwordBuf)).toBe(false);
    expect(zeroed(prfBuf)).toBe(false);
  });
});

/* ------------------------------------------------------------------- F8 */

const RP = { rpId: "wallet-harness.qntx.org", rpName: "Harness" };
const BACKUP_SALT = "harness/backup/v1";
const OWNER_PRF = new Uint8Array(32).fill(0x5a);
const kernelBackupPasskey = { kind: "passkey" as const, ceremony: "kernel" as const, ...RP };

/** A platform authenticator that always asserts the same credential with the owner's PRF. */
const ownerAuthenticator = (): PasskeyAuthenticator => {
  const answer = async () => {
    await Promise.resolve();
    return {
      credentialId: new Uint8Array([7, 7, 7, 7]),
      first: new Uint8Array(OWNER_PRF),
      second: undefined,
      userHandle: undefined,
      synced: true,
      userVerified: true,
    };
  };
  return { create: answer, get: answer };
};

const nativeHarness = (seed: number) =>
  createHarness({
    seed,
    keystore: fakeKeystore().keystore,
    passkey: ownerAuthenticator(),
    noIdle: true,
  });

const backupPassword = () => ({
  kind: "password" as const,
  password: utf8ToBytes("correct horse battery"),
});

describe("POC F8: restore adopts unauthenticated envelope.factors verbatim", () => {
  it("POC F8: a tampered factor list is adopted wholesale by a kernel-passkey restore", async () => {
    const a = nativeHarness(110);
    await a.settle();
    const created = ok(
      await a.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"),
        factor: { kind: "device" },
      }),
    );
    const aSession = strField(created, "session");
    ok(
      await a.call(
        "backup.enable",
        {
          verify: { kind: "hardware" },
          factors: [{ ...kernelBackupPasskey, backupSalt: BACKUP_SALT }, backupPassword()],
        },
        aSession,
      ),
    );
    const envelopeText = strField(ok(await a.call("backup.update", null, aSession)), "envelope");

    // Tamper: drop the owner's password entry, append a junk one of the right shape.
    const envelope = JSON.parse(envelopeText) as {
      factors: Array<Record<string, unknown>>;
    };
    const passkeyEntry = envelope.factors.find((f) => f["kind"] === "passkey");
    expect(passkeyEntry).toBeDefined();
    const junkPassword = {
      kind: "password",
      kdf: "argon2id",
      memoryKiB: 65_536,
      passes: 3,
      lanes: 4,
      salt: base64urlnopad.encode(new Uint8Array(16).fill(0xaa)),
      sealedBek: base64urlnopad.encode(new Uint8Array(73).fill(0xbb)),
    };
    const tampered = {
      ...envelope,
      factors: [passkeyEntry, junkPassword],
    };
    const tamperedText = JSON.stringify(tampered);

    const b = nativeHarness(111);
    await b.settle();
    const restored = ok(
      await b.call("backup.restore", {
        envelope: tamperedText,
        backupFactor: {
          kind: "passkey",
          ceremony: "kernel",
          rpId: RP.rpId,
          backupSalt: BACKUP_SALT,
        },
        factor: { kind: "device" },
      }),
    );
    const bSession = strField(restored, "session");

    // The vault adopted the envelope's factor list verbatim: the junk password entry rides
    // every future update and the owner's real password entry is gone.
    const updated = JSON.parse(
      strField(ok(await b.call("backup.update", null, bSession)), "envelope"),
    ) as { factors: ReadonlyArray<Record<string, unknown>> };
    expect(updated.factors).toContainEqual(junkPassword);
    expect(updated.factors.filter((f) => f["kind"] === "password")).toHaveLength(1);
    const originalSalts = envelope.factors
      .filter((f) => f["kind"] === "password")
      .map((f) => f["salt"]);
    for (const f of updated.factors) {
      expect(originalSalts).not.toContain(f["salt"]);
    }
  });
});

/* ------------------------------------------------------------------- F9 */

type Field = { name: string; type: string };
const eipFields = (spec: string): Field[] =>
  spec.split(",").map((part) => {
    const [type, name] = part.trim().split(" ");
    return { type: type ?? "", name: name ?? "" };
  });

const SEAPORT_16 = "0x0000000000000068F116a894984e2DB1123eB395";
const OFFERER = "0x00000000000000000000000000000000DeaDBeef";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const NFT = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";

const OFFER_ITEM = eipFields(
  "uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount",
);

const offerItem = (itemType: number, token: string, identifier = "1") => ({
  itemType,
  token,
  identifierOrCriteria: identifier,
  startAmount: "1",
  endAmount: "1",
});

const seaportDoc5Offers = {
  types: {
    EIP712Domain: eipFields("string name, string version, uint256 chainId, address verifyingContract"),
    OrderComponents: eipFields(
      "address offerer, address zone, OfferItem[] offer, ConsiderationItem[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 counter",
    ),
    OfferItem: OFFER_ITEM,
    ConsiderationItem: [...OFFER_ITEM, { type: "address", name: "recipient" }],
  },
  primaryType: "OrderComponents",
  domain: {
    name: "Seaport",
    version: "1.6",
    chainId: 1,
    verifyingContract: SEAPORT_16,
  },
  message: {
    offerer: OFFERER,
    zone: ZERO_ADDR,
    offer: [1, 2, 3, 4, 5].map((i) => offerItem(2, NFT, String(i))),
    consideration: [
      { ...offerItem(1, TOKEN), startAmount: "5000000", endAmount: "5000000", recipient: OFFERER },
    ],
    orderType: 0,
    startTime: "1700000000",
    endTime: "1700001000",
    zoneHash: `0x${"00".repeat(32)}`,
    salt: "123",
    conduitKey: `0x${"00".repeat(32)}`,
    counter: "0",
  },
};

const EVM_ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm" } as const;
const POC_SIGNER = "0x2222222222222222222222222222222222222222";

describe("POC F9: Seaport offer items beyond 4 are truncated but the order is not blind", () => {
  it("POC F9: decodeEvm describes the 5-offer order and the prompt truncates silently", () => {
    const intent = decodeEvm(
      {
        kind: "evm.typed-data",
        network: "eip155:1",
        account: EVM_ACCOUNT,
        typedData: JSON.stringify(seaportDoc5Offers),
      },
      POC_SIGNER,
    );
    expect(intent.blind).toBeUndefined();
    expect(intent.message?.kind).toBe("typed-data");
    const prompt = chainPrompt("en", intent);
    expect(prompt.description).toContain("1 more items not shown");
  });
});
