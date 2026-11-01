import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import type { Harness, KernelResponse } from "./harness.ts";
import { createHarness } from "./harness.ts";
import { loadVectors } from "./helpers.ts";

const passkeyVector = loadVectors("passkey.json") as {
  vector: { prf: string; mnemonic: string; walletId: string };
};
const nip06 = loadVectors("nip06.json") as {
  vectors: Array<{ mnemonic: string; privateKey: string; publicKey: string; nsec: string }>;
};

const PRF_WALLET = hexToBytes(passkeyVector.vector.prf);
const PRF_VAULT = hexToBytes("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PASSWORD = utf8ToBytes("correct horse battery");

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}

/** All Uint8Arrays and strings reachable inside a posted message. */
function collectFragments(value: unknown, bytes: Uint8Array[], strings: string[], depth = 0): void {
  if (depth > 10 || value === null || typeof value !== "object") {
    if (typeof value === "string") {
      strings.push(value);
    }
    return;
  }
  if (value instanceof Uint8Array) {
    bytes.push(value);
    return;
  }
  const items: ReadonlyArray<unknown> = Array.isArray(value) ? value : Object.values(value);
  for (const item of items) {
    collectFragments(item, bytes, strings, depth + 1);
  }
}

function messageId(message: ProtocolValue): number | undefined {
  // Arrays and Uint8Array both carry Symbol.iterator; plain records do not.
  if (
    typeof message === "object" &&
    message !== null &&
    !(Symbol.iterator in message) &&
    typeof message["id"] === "number"
  ) {
    return message["id"];
  }
  return undefined;
}

function nonExempt(
  posted: ReadonlyArray<ProtocolValue>,
  exempt: ReadonlySet<number>,
): ProtocolValue[] {
  return posted.flatMap((m, i) => (exempt.has(i) ? [] : [m]));
}

function containsSubsequence(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || haystack.length < needle.length) {
    return false;
  }
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

/**
 * Exercises the whole API surface and asserts no secret ever crosses the port except inside the
 * designated export/createMnemonic/dataKeys result fields.
 */
describe("leak check", () => {
  it("no secret byte sequence appears in any posted message", async () => {
    const h: Harness = createHarness({ seed: 42 });
    await h.settle();

    // Designated secret-carrying responses are exempt by their index in `posted`.
    const exemptIds = new Set<number>();
    const exempt = (response: KernelResponse): void => {
      exemptIds.add(h.posted.findIndex((m) => messageId(m) === response.id));
    };

    const created = ok(
      await h.call("wallet.createWithPasskey", {
        ceremony: "host",
        credentialId: CREDENTIAL_ID,
        prfWallet: new Uint8Array(PRF_WALLET),
        synced: true,
        factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
      }),
    );
    const session = (created as Record<string, ProtocolValue>)["session"] as string;

    // createMnemonic words is a designated secret carrier.
    const draftRes = await h.call("wallet.createMnemonic", { words: 12 }, session);
    exempt(draftRes);
    const draft = ok(draftRes);
    const draftId = (draft as Record<string, ProtocolValue>)["draft"] as string;
    await h.call("wallet.discardMnemonic", { draft: draftId }, session);

    await h.call(
      "nostr.importKey",
      { input: { kind: "nsec", nsec: utf8ToBytes(nip06.vectors[0]!.nsec) } },
      session,
    );
    await h.call("nostr.generateKey", {}, session);
    await h.call("nostr.createNip46ClientKey", null, session);
    exempt(await h.call("dataKeys.get", { purpose: "leak-test" }, session));
    exempt(
      await h.call(
        "wallet.exportMnemonic",
        {
          verify: {
            kind: "passkey",
            credentialId: CREDENTIAL_ID,
            prf: new Uint8Array(PRF_VAULT),
          },
          walletId: passkeyVector.vector.walletId,
        },
        session,
      ),
    );
    exempt(
      await h.call(
        "nostr.exportKey",
        {
          verify: {
            kind: "passkey",
            credentialId: CREDENTIAL_ID,
            prf: new Uint8Array(PRF_VAULT),
          },
          publicKey: nip06.vectors[0]!.publicKey,
          format: { kind: "nsec" },
        },
        session,
      ),
    );
    // Exercise the S7 paths: a password addFactor rotates the DEK (fresh keyId, resealed
    // records, rewrapped factors); a passkey addFactor wraps the live DEK only.
    ok(
      await h.call(
        "vault.addFactor",
        {
          verify: {
            kind: "passkey",
            credentialId: CREDENTIAL_ID,
            prf: new Uint8Array(PRF_VAULT),
          },
          factor: { kind: "password", password: utf8ToBytes("leak test password") },
        },
        session,
      ),
    );

    // The spark.* methods run their full derivation chain (entropy → seed → accountKey) in this
    // harness before the injected backend fails — no derived material may appear on the wire.
    const sparkAccount = {
      walletId: passkeyVector.vector.walletId,
      groupIndex: 0,
      network: "mainnet" as const,
    };
    await h.call("spark.identityPublicKey", { account: sparkAccount }, session);
    await h.call(
      "spark.signIdentity",
      {
        account: sparkAccount,
        statement: { kind: "spark-invoice", invoice: new Uint8Array(24) },
      },
      session,
    );
    await h.call(
      "spark.prepareTransfer",
      {
        account: sparkAccount,
        request: {
          transferId: "3f7b2e1c-1a2b-4c3d-8e4f-000000000002",
          leaves: [
            {
              leafId: "3f7b2e1c-1a2b-4c3d-8e4f-000000000001",
              key: { type: "leaf", leafId: "3f7b2e1c-1a2b-4c3d-8e4f-000000000001" },
              receiverIdentityPublicKey: new Uint8Array(33),
            },
          ],
        },
      },
      session,
    );
    await h.call(
      "spark.identityPublicKey",
      { account: { ...sparkAccount, walletId: "ffffffffffffffff" } },
      session,
    );

    // Lock is host-side: the respawned kernel over the same store is a fresh enclave.
    const h2 = createHarness({ seed: 43, store: h.store });
    await h2.settle();
    await h2.call("vault.unlock", {
      factor: {
        kind: "passkey",
        credentialId: CREDENTIAL_ID,
        prf: new Uint8Array(PRF_VAULT),
      },
    });

    // Known secrets: every PRF input, the password bytes, every ≥32-byte random draw (DEKs,
    // generated keys — session/draft ids are 16 bytes and are deliberately public), the vector
    // entropy/private keys, and the mnemonic text.
    const secrets: Uint8Array[] = [
      PRF_WALLET,
      PRF_VAULT,
      PASSWORD,
      utf8ToBytes(passkeyVector.vector.mnemonic),
      utf8ToBytes("leak test password"),
      hexToBytes(nip06.vectors[0]!.privateKey),
      ...h.draws.filter((d) => d.length >= 32),
    ];

    for (const message of nonExempt([...h.posted, ...h2.posted], exemptIds)) {
      const bytes: Uint8Array[] = [];
      const strings: string[] = [];
      collectFragments(message, bytes, strings);
      for (const secret of secrets) {
        for (const fragment of bytes) {
          expect(containsSubsequence(fragment, secret)).toBe(false);
        }
        const hex = bytesToHex(secret);
        for (const s of strings) {
          expect(s).not.toContain(hex);
        }
      }
    }
  });
});
