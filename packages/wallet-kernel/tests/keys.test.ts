import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import Slip10 from "micro-key-producer/slip10.js";
import { describe, expect, it } from "vite-plus/test";

import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import { signEvmPersonalMessage } from "@qntx/wallet-chains/evm/sign";
import { normalizeSolana, solanaAddressFromPublicKey } from "@qntx/wallet-chains/solana";
import { signSolanaMessage } from "@qntx/wallet-chains/solana/sign";

import { wipe } from "../src/secret/secret.ts";
import type { KernelResponse } from "./harness.ts";
import { createHarness } from "./harness.ts";
import { loadVectors } from "./helpers.ts";

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF_VAULT = hexToBytes("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
const PASSKEY = () => ({
  kind: "passkey" as const,
  credentialId: new Uint8Array(utf8ToBytes("credential-1")),
  prf: hexToBytes("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
});
const MNEMONIC = utf8ToBytes(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const EVM_SECRET = new Uint8Array(32).fill(0x11);
const SOL_SECRET = new Uint8Array(32).fill(0x22);

const ok = (r: KernelResponse): Record<string, unknown> => {
  if ("err" in r) {
    throw new Error(JSON.stringify(r));
  }
  return r.ok as Record<string, unknown>;
};

const err = (r: KernelResponse): string | undefined => {
  if ("err" in r) {
    return r.err.code;
  }
  return undefined;
};

const must = <T>(value: T | null | undefined): T => {
  if (value === undefined || value === null) {
    throw new Error("expected a defined value");
  }
  return value;
};

const mustFind = <T extends { readonly kind: string; readonly id: string }>(
  records: ReadonlyArray<T>,
  kind: string,
  id: string,
): T => {
  const record = records.find((r) => r.kind === kind && r.id === id);
  if (record === undefined) {
    throw new Error(`missing ${kind} record ${id}`);
  }
  return record;
};

const setup = async () => {
  const h = createHarness();
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", {
      mnemonic: new Uint8Array(MNEMONIC),
      factor: {
        kind: "passkey",
        credentialId: new Uint8Array(CREDENTIAL_ID),
        prf: new Uint8Array(PRF_VAULT),
      },
    }),
  );
  const wallet = res["wallet"] as { walletId: string };
  return { h, session: (res as { session: string }).session, walletId: wallet.walletId };
};

describe("keys.import", () => {
  it("imports an EVM key: returns keyId/family/address, lists and exports", async () => {
    const { h, session } = await setup();
    const res = ok(
      await h.call("keys.import", { family: "evm", secret: new Uint8Array(EVM_SECRET) }, session),
    );
    const expected = evmAddressFromPublicKey(
      secp256k1.getPublicKey(new Uint8Array(EVM_SECRET), true),
    );
    expect(res["address"]).toBe(expected);
    expect(res["family"]).toBe("evm");
    const keyId = res["keyId"] as string;
    expect(keyId).toMatch(/^[0-9a-f]{16}$/);
    const list = ok(await h.call("keys.list", null, session)) as unknown as Array<{
      keyId: string;
    }>;
    expect(list.map((k) => k.keyId)).toContain(keyId);
    const exported = ok(
      await h.call("keys.export", { verify: PASSKEY(), keyId }, session),
    ) as unknown as Uint8Array;
    expect(new TextDecoder().decode(exported)).toBe(`0x${Buffer.from(EVM_SECRET).toString("hex")}`);
    expect(err(await h.call("keys.remove", { verify: PASSKEY(), keyId }, session))).toBeUndefined();
    const after = ok(await h.call("keys.list", null, session)) as unknown as unknown[];
    expect(after).toHaveLength(0);
  });

  it("imports a Solana seed and a 64-byte keypair; rejects mismatched keypairs", async () => {
    const { h, session } = await setup();
    const seedRes = ok(
      await h.call(
        "keys.import",
        { family: "solana", secret: new Uint8Array(SOL_SECRET) },
        session,
      ),
    );
    const expected = solanaAddressFromPublicKey(ed25519.getPublicKey(new Uint8Array(SOL_SECRET)));
    expect(seedRes["address"]).toBe(expected);
    const keypair = new Uint8Array(64);
    keypair.set(new Uint8Array(SOL_SECRET), 0);
    keypair.set(ed25519.getPublicKey(new Uint8Array(SOL_SECRET)), 32);
    const dup = await h.call(
      "keys.import",
      { family: "solana", secret: new Uint8Array(keypair) },
      session,
    );
    expect(err(dup)).toBe("conflict"); // same seed → same keyId
    const bad = new Uint8Array(64);
    bad.set(new Uint8Array(SOL_SECRET), 0);
    bad.set(new Uint8Array(32).fill(9), 32);
    const mism = await h.call(
      "keys.import",
      { family: "solana", secret: new Uint8Array(bad) },
      session,
    );
    expect(err(mism)).toBe("invalid-input");
  });

  it("refuses a private key that derives an own EVM or Solana account", async () => {
    const { h, session } = await setup();
    const seed = mnemonicToSeedSync(new TextDecoder().decode(MNEMONIC));
    try {
      // evm.bip44 group 0 — m/44'/60'/0'/0/0 — and solana.bip44-change group 0 —
      // m/44'/501'/0'/0' — of the test mnemonic, derived exactly like ownAddresses does.
      const evmChild = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0");
      const solChild = Slip10.fromMasterSeed(seed).derive("m/44'/501'/0'/0'");
      const evmSecret = new Uint8Array(must(evmChild.privateKey));
      const solSecret = new Uint8Array(solChild.privateKey);
      try {
        expect(evmSecret).toHaveLength(32);
        expect(
          err(await h.call("keys.import", { family: "evm", secret: evmSecret }, session)),
        ).toBe("conflict");
        expect(
          err(await h.call("keys.import", { family: "solana", secret: solSecret }, session)),
        ).toBe("conflict");
      } finally {
        evmChild.wipePrivateData();
        wipe(solChild.privateKey);
      }
      // A key that is not a derived account still imports.
      const res = ok(
        await h.call("keys.import", { family: "evm", secret: new Uint8Array(32).fill(3) }, session),
      );
      expect(res["family"]).toBe("evm");
    } finally {
      wipe(seed);
    }
  });

  it("rejects malformed secrets and unsupported families", async () => {
    const { h, session } = await setup();
    // The wire bound is 32–64 bytes — shorter or longer secrets are malformed requests.
    expect(
      err(
        await h.call(
          "keys.import",
          { family: "evm", secret: new Uint8Array(31).fill(0x11) },
          session,
        ),
      ),
    ).toBe("integrity");
    // Zero is not a valid secp256k1 scalar.
    expect(
      err(await h.call("keys.import", { family: "evm", secret: new Uint8Array(32) }, session)),
    ).toBe("invalid-input");
    // Inside the wire bound but not a valid Solana length — the kernel checks.
    expect(
      err(
        await h.call(
          "keys.import",
          { family: "solana", secret: new Uint8Array(33).fill(0x22) },
          session,
        ),
      ),
    ).toBe("invalid-input");
    expect(
      err(
        await h.call(
          "keys.import",
          { family: "solana", secret: new Uint8Array(65).fill(0x22) },
          session,
        ),
      ),
    ).toBe("integrity");
    // The family byte is reserved for Bitcoin, but WIF/raw BTC import is out of scope.
    expect(
      err(
        await h.call(
          "keys.import",
          { family: "bitcoin", secret: new Uint8Array(32).fill(0x33) },
          session,
        ),
      ),
    ).toBe("invalid-input");
  });

  it("refuses a second import of the same EVM key", async () => {
    const { h, session } = await setup();
    ok(await h.call("keys.import", { family: "evm", secret: new Uint8Array(EVM_SECRET) }, session));
    expect(
      err(
        await h.call("keys.import", { family: "evm", secret: new Uint8Array(EVM_SECRET) }, session),
      ),
    ).toBe("conflict");
  });

  it("wipes the caller's secret buffer after import", async () => {
    const { h, session } = await setup();
    const secret = new Uint8Array(EVM_SECRET);
    ok(await h.call("keys.import", { family: "evm", secret }, session));
    expect(secret.every((b) => b === 0)).toBe(true);
    // A 64-byte Solana keypair input is wiped wholesale, public half included.
    const keypair = new Uint8Array(64);
    keypair.set(SOL_SECRET, 0);
    keypair.set(ed25519.getPublicKey(SOL_SECRET), 32);
    ok(await h.call("keys.import", { family: "solana", secret: keypair }, session));
    expect(keypair.every((b) => b === 0)).toBe(true);
  });

  it("export and remove verify the factor before acting", async () => {
    const { h, session } = await setup();
    const imp = ok(
      await h.call("keys.import", { family: "evm", secret: new Uint8Array(EVM_SECRET) }, session),
    );
    const keyId = imp["keyId"] as string;
    const wrong = {
      kind: "passkey" as const,
      credentialId: utf8ToBytes("other-credential"),
      prf: new Uint8Array(32).fill(9),
    };
    expect(err(await h.call("keys.export", { verify: wrong, keyId }, session))).toBe(
      "wrong-passkey",
    );
    expect(err(await h.call("keys.remove", { verify: wrong, keyId }, session))).toBe(
      "wrong-passkey",
    );
    const list = ok(await h.call("keys.list", null, session)) as unknown as Array<{
      keyId: string;
    }>;
    expect(list.map((k) => k.keyId)).toContain(keyId);
  });

  it("a tampered key record fails integrity when opened", async () => {
    const { h, session } = await setup();
    const imp = ok(
      await h.call("keys.import", { family: "evm", secret: new Uint8Array(EVM_SECRET) }, session),
    );
    const keyId = imp["keyId"] as string;
    const image = await h.store.load();
    const record = mustFind(image.records, "key", keyId);
    const tampered = new Uint8Array(record.sealed);
    const view = new DataView(tampered.buffer, tampered.byteOffset, tampered.byteLength);
    view.setUint8(0, view.getUint8(0) ^ 0xff);
    await h.store.commit([{ op: "put-record", record: { ...record, sealed: tampered } }]);
    await h.settle();
    expect(err(await h.call("keys.export", { verify: PASSKEY(), keyId }, session))).toBe(
      "integrity",
    );
  });

  it("a tampered key header fails integrity in keys.list", async () => {
    const { h, session } = await setup();
    const imp = ok(
      await h.call("keys.import", { family: "evm", secret: new Uint8Array(EVM_SECRET) }, session),
    );
    const keyId = imp["keyId"] as string;
    const image = await h.store.load();
    const record = mustFind(image.records, "key", keyId);
    // Family is authenticated header data — an unknown value fails parseKeyHeader.
    const tamperedHeader = record.header.replace('"evm"', '"nope"');
    expect(tamperedHeader).not.toBe(record.header);
    await h.store.commit([{ op: "put-record", record: { ...record, header: tamperedHeader } }]);
    await h.settle();
    expect(err(await h.call("keys.list", null, session))).toBe("integrity");
  });
});

describe("chain.sign (imported)", () => {
  it("signs an EVM personal message with the imported key", async () => {
    const { h, session } = await setup();
    const imp = ok(
      await h.call("keys.import", { family: "evm", secret: new Uint8Array(EVM_SECRET) }, session),
    );
    const keyId = imp["keyId"] as string;
    const res = ok(
      await h.call(
        "chain.sign",
        {
          request: {
            kind: "evm.personal-message",
            network: "eip155:1",
            account: { kind: "imported", keyId, family: "evm" },
            message: utf8ToBytes("hello imported"),
          },
          verify: PASSKEY(),
        },
        session,
      ),
    );
    const expected = signEvmPersonalMessage(
      utf8ToBytes("hello imported"),
      new Uint8Array(EVM_SECRET),
    );
    expect(res["signature"]).toStrictEqual(expected);
  });

  it("signs a Solana message with the imported seed", async () => {
    const { h, session } = await setup();
    const imp = ok(
      await h.call(
        "keys.import",
        { family: "solana", secret: new Uint8Array(SOL_SECRET) },
        session,
      ),
    );
    const keyId = imp["keyId"] as string;
    const res = ok(
      await h.call(
        "chain.sign",
        {
          request: normalizeSolana(
            {
              kind: "solana.message",
              network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
              account: { kind: "imported", keyId, family: "solana" },
              message: utf8ToBytes("hello solana"),
              format: "raw",
            },
            imp["address"] as string,
          ),
          verify: PASSKEY(),
        },
        session,
      ),
    );
    const signature = res["signature"] as Uint8Array;
    const expected = signSolanaMessage(utf8ToBytes("hello solana"), new Uint8Array(SOL_SECRET));
    expect(signature).toStrictEqual(expected);
    // The imported address is the ed25519 public key — the signature must verify under it.
    expect(
      ed25519.verify(
        signature,
        utf8ToBytes("hello solana"),
        base58.decode(imp["address"] as string),
      ),
    ).toBe(true);
  });

  it("byte-matches the viem-checked vector for an imported EVM key", async () => {
    const vectors = loadVectors("chains/evm.json") as {
      privateKey: string;
      personalMessage: string;
      expected: { personalMessage: string };
    };
    const { h, session } = await setup();
    const secret = hexToBytes(vectors.privateKey.slice(2));
    const imp = ok(await h.call("keys.import", { family: "evm", secret }, session));
    expect(imp["address"]).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    const res = ok(
      await h.call(
        "chain.sign",
        {
          request: {
            kind: "evm.personal-message",
            network: "eip155:1",
            account: { kind: "imported", keyId: imp["keyId"], family: "evm" },
            message: hexToBytes(vectors.personalMessage.slice(2)),
          },
          verify: PASSKEY(),
        },
        session,
      ),
    );
    // vectors.expected.personalMessage is byte-matched against viem in wallet-chains tests.
    expect(res["signature"]).toStrictEqual(hexToBytes(vectors.expected.personalMessage.slice(2)));
  });

  it("refuses a request whose family does not match the key", async () => {
    const { h, session } = await setup();
    const imp = ok(
      await h.call("keys.import", { family: "evm", secret: new Uint8Array(EVM_SECRET) }, session),
    );
    const res = await h.call(
      "chain.sign",
      {
        request: {
          kind: "solana.message",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          account: { kind: "imported", keyId: imp["keyId"], family: "solana" },
          message: utf8ToBytes("mismatch"),
          format: "raw",
        },
        verify: PASSKEY(),
      },
      session,
    );
    expect(err(res)).toBe("invalid-input");
  });

  it("refuses an imported ref on a bitcoin request", async () => {
    const { h, session } = await setup();
    const res = await h.call(
      "chain.sign",
      {
        request: {
          kind: "bitcoin.message",
          network: "bip122:000000000019d6689c085ae165831e93",
          account: { kind: "imported", keyId: "00".repeat(8), family: "bitcoin" },
          address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
          message: "hello",
          format: "bip322-simple",
          change: 0,
          index: 0,
        },
        verify: PASSKEY(),
      },
      session,
    );
    expect(err(res)).toBe("unsupported");
  });
});
