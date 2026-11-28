// The vault side of a card wallet: the `card-wallet` record contributes a CardWalletInfo to
// status, every seed-seeking method answers `unsupported` (chain.sign: `device-required`),
// `wallet.accounts` answers from the cached public material, delete removes only the record, a
// backup never carries it, and a malformed sealed body latches the vault corrupted at reconcile.

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import Slip10 from "micro-key-producer/slip10.js";
import { describe, expect, it } from "vite-plus/test";

import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import { solanaAddressFromPublicKey } from "@qntx/wallet-chains/solana";
import { tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";
import type { ProtocolValue } from "@qntx/wallet/protocol";
import type { WalletInfo } from "@qntx/wallet/types";

import { walletIdOf } from "../src/derive/wallet-id.ts";
import { KernelError } from "../src/errors.ts";
import { cardId } from "../src/modules/card/protocol/identity.ts";
import type { CardWalletBody, CardWalletHeader } from "../src/modules/card/record.ts";
import {
  CARD_WALLET_KIND,
  encodeCardWalletBody,
  encodeCardWalletHeader,
  parseCardWalletBody,
  parseCardWalletHeader,
} from "../src/modules/card/record.ts";
import type { Secret } from "../src/secret/secret.ts";
import { wipe } from "../src/secret/secret.ts";
import { entropyFromMnemonic } from "../src/seed/mnemonic.ts";
import { seedFromEntropy } from "../src/seed/seed.ts";
import { passkeyKek, unwrapDek } from "../src/vault/factors.ts";
import { withManifest } from "../src/vault/manifest.ts";
import type { StoredRecord } from "../src/vault/store.ts";
import { sealRecord } from "../src/vault/vault.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { loadVectors, subtlePbkdf2 } from "./helpers.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const CREDENTIAL_ID = utf8ToBytes("credential-1");
// Fresh bytes each call — the kernel wipes factor buffers after using them.
const T0 = 1_700_000_000_000;
const SCHEME = "hyperliquid-l1-agent";

const sealer = {
  random: (n: number) => new Uint8Array(n).fill(3),
  now: () => T0,
} as never;

const verifyPasskey = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prf: new Uint8Array(32).fill(1),
});

const field = (value: unknown, key: string): unknown => (value as Record<string, unknown>)[key];
const strField = (value: unknown, key: string): string => String(field(value, key));
const arrField = (value: unknown, key: string): unknown[] => field(value, key) as unknown[];
const ok = (res: { ok?: unknown; err?: unknown }): unknown => {
  if (!("ok" in res)) {
    throw new Error(`call failed: ${JSON.stringify(res.err)}`);
  }
  return res.ok;
};
const errCode = async (res: Promise<KernelResponse>): Promise<string> => {
  const response = await res;
  if (!("err" in response)) {
    throw new Error("call did not fail");
  }
  return response.err.code;
};

/** Narrows a wallet info to the card arm for assertions on card-only fields. */
const cardOf = (info: WalletInfo | undefined): Extract<WalletInfo, { custody: "card" }> => {
  if (info === undefined || info.custody !== "card") {
    throw new Error("expected a card wallet");
  }
  return info;
};

/** The planted card-wallet record — `if` narrowing trips no-conditional-in-test. */
const planted = (records: ReadonlyArray<StoredRecord>, walletId: string): StoredRecord => {
  const record = records.find((r) => r.id === walletId);
  if (record === undefined) {
    throw new Error("card-wallet record not planted");
  }
  return record;
};

/** The registration set a create/import tap caches, derived locally from the test seed. */
const cardBody = (seed: Uint8Array): { body: CardWalletBody; walletId: string } => {
  const master = HDKey.fromMasterSeed(seed);
  const slip = Slip10.fromMasterSeed(seed);
  const nodes: Record<string, { key: string; chainCode: string }> = {};
  const ed25519Keys: Record<string, string> = {};
  try {
    const masterPublic = master.publicKey;
    if (masterPublic === null) {
      throw new Error("no master public key");
    }
    const add = (path: string): void => {
      const node = master.derive(path);
      try {
        const { publicKey } = node;
        if (publicKey === null) {
          throw new Error(`no public key at ${path}`);
        }
        const { chainCode } = node;
        if (chainCode === null) {
          throw new Error(`no chain code at ${path}`);
        }
        nodes[path] = {
          key: bytesToHex(publicKey),
          chainCode: bytesToHex(chainCode),
        };
      } finally {
        node.wipePrivateData();
      }
    };
    add("m/44'/60'/0'");
    add("m/44'/195'/0'");
    for (const purpose of [44, 49, 84, 86]) {
      add(`m/${purpose}'/0'`);
      for (let group = 0; group < 3; group += 1) {
        add(`m/${purpose}'/0'/${group}'`);
      }
    }
    for (let group = 0; group < 3; group += 1) {
      const node = slip.derive(`m/44'/501'/${group}'/0'`);
      try {
        const { privateKey } = node;
        if (privateKey === null) {
          throw new Error("no private key");
        }
        ed25519Keys[`m/44'/501'/${group}'/0'`] = bytesToHex(ed25519.getPublicKey(privateKey));
      } finally {
        wipe(node.privateKey);
      }
    }
    return {
      walletId: walletIdOf(masterPublic),
      body: {
        master: bytesToHex(masterPublic),
        nodes,
        ed25519: ed25519Keys,
        ephemerals: {},
      },
    };
  } finally {
    master.wipePrivateData();
    wipe(slip.privateKey);
    wipe(seed);
  }
};

const testCard = (): { identity: Uint8Array; cardId: string; cert: string } => {
  const identity = secp256k1.getPublicKey(new Uint8Array(32).fill(7), true);
  return {
    identity,
    cardId: bytesToHex(cardId(identity)),
    cert: bytesToHex(identity) + "00".repeat(64),
  };
};

/** Unwraps the live session DEK the same way unlock did — from the test passkey factor's KEK. */
const sessionDek = async (h: Harness): Promise<Secret> => {
  const image = await h.store.load();
  const factor = image.factors.find((f) => f.kind === "passkey");
  if (factor === undefined) {
    throw new Error("missing passkey factor");
  }
  const kek = passkeyKek(new Uint8Array(32).fill(1), CREDENTIAL_ID);
  try {
    return unwrapDek(kek, factor);
  } finally {
    wipe(kek);
  }
};

const createWallet = async (h: Harness): Promise<{ session: string }> => {
  const res = ok(
    await h.call("wallet.createWithPasskey", {
      ceremony: "host",
      credentialId: CREDENTIAL_ID,
      prfWallet: new Uint8Array(32).fill(2),
      synced: true,
      factor: {
        kind: "passkey" as const,
        credentialId: CREDENTIAL_ID,
        prf: new Uint8Array(32).fill(1),
      },
    }),
  );
  return { session: strField(res, "session") };
};

/**
 * Plants a `card-wallet` record directly in the store — the record arrives through a commit like
 * one written by card.create (later layer); the kernel reconciles and claims its body.
 */
const plantCardWallet = async (
  h: Harness,
  header: CardWalletHeader,
  body: CardWalletBody,
): Promise<void> => {
  const dek = await sessionDek(h);
  try {
    const image = await h.store.load();
    const record = sealRecord(
      sealer,
      dek,
      CARD_WALLET_KIND,
      header.walletId,
      encodeCardWalletHeader(header),
      utf8ToBytes(encodeCardWalletBody(body)),
    );
    await h.store.commit(withManifest(sealer, image, [{ op: "put-record", record }], dek));
  } finally {
    dek.wipe();
  }
  await h.settle();
};

const headerFor = (
  walletId: string,
  cards: CardWalletHeader["cards"],
  members: ReadonlyArray<string>,
): CardWalletHeader => ({
  v: 1,
  walletId,
  origin: "generated",
  createdAt: T0,
  members,
  cards,
});

const walletsOf = async (h: Harness, session: string): Promise<WalletInfo[]> => {
  const status = ok(await h.call("status", null, session)) as { wallets: WalletInfo[] };
  return status.wallets;
};

const seed = await seedFromEntropy(entropyFromMnemonic(MNEMONIC), "", subtlePbkdf2);
const { body, walletId } = cardBody(seed);
const card = testCard();
const peer = secp256k1.getPublicKey(new Uint8Array(32).fill(8), true);
const peerId = bytesToHex(cardId(peer));

const setup = async (): Promise<{ h: Harness; session: string }> => {
  const h = createHarness();
  await h.settle();
  const { session } = await createWallet(h);
  await plantCardWallet(
    h,
    headerFor(
      walletId,
      [
        { cardId: card.cardId, cert: card.cert, state: "ready", tries: 10, verifiedAt: T0 },
        { cardId: peerId, state: "unknown" },
      ],
      [card.cardId, peerId],
    ),
    body,
  );
  return { h, session };
};

describe("card-wallet record", () => {
  it("round-trips its canonical encodings", () => {
    const header = headerFor(
      walletId,
      [
        { cardId: card.cardId, cert: card.cert, state: "ready", tries: 10, verifiedAt: T0 },
        { cardId: peerId, state: "pending" },
      ],
      [card.cardId, peerId],
    );
    const headerText = encodeCardWalletHeader(header);
    expect(parseCardWalletHeader(headerText)).toStrictEqual(header);
    const bodyText = encodeCardWalletBody(body);
    expect(parseCardWalletBody(bodyText, walletId)).toStrictEqual(body);
  });

  it("status contributes a CardWalletInfo", async () => {
    const { h, session } = await setup();
    const wallets = await walletsOf(h, session);
    const found = wallets.find((w) => w.walletId === walletId);
    expect(found).toBeDefined();
    const cardInfo = cardOf(found);
    expect(cardInfo.origin).toBe("card-generated");
    expect(cardInfo.backup).toBe("cards");
    expect(cardInfo.members).toBe(2);
    expect(cardInfo.cards[0]?.cardId).toBe(card.cardId);
    expect(cardInfo.cards[0]?.shortId).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(cardInfo.cards[0]?.state).toBe("ready");
    expect(cardInfo.cards[1]?.shortId).toBeUndefined();
    // The passkey wallet reports the vault arm of the union.
    expect(wallets.find((w) => w.custody === "vault")).toBeDefined();
  });

  it("seed-seeking methods refuse the card wallet", async () => {
    const { h, session } = await setup();
    const calls = [
      ["nostr.deriveKey", { walletId, index: 0 }],
      ["nostr.syncKey", { walletId }],
      [
        "sessions.create",
        {
          scheme: SCHEME,
          owner: { walletId, groupIndex: 0 },
          scope: "Mainnet",
          name: "bot-1",
          validUntil: T0 + 86_400_000,
          limits: { notional: "1000000000", maxLeverage: 100, assets: [0, 1] },
          verify: verifyPasskey(),
        },
      ],
      ["spark.identityPublicKey", { account: { walletId, groupIndex: 0, network: "mainnet" } }],
    ] as const;
    await Promise.all(
      calls.map(async ([method, params]) => {
        await expect(errCode(h.call(method, params, session))).resolves.toBe("unsupported");
      }),
    );
    await expect(
      errCode(h.call("wallet.exportMnemonic", { walletId, verify: verifyPasskey() }, session)),
    ).resolves.toBe("unsupported");
  });

  it("chain.sign answers device-required", async () => {
    const { h, session } = await setup();
    const code = await errCode(
      h.call(
        "chain.sign",
        {
          request: {
            kind: "evm.personal-message",
            network: "eip155:1",
            account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
            message: utf8ToBytes("hello"),
          },
          verify: verifyPasskey(),
        },
        session,
      ),
    );
    expect(code).toBe("device-required");
  });

  it("wallet.accounts answers from card material; misses answer device-required", async () => {
    const { h, session } = await setup();
    const accounts = async (groupIndex: number, template: string, network: string) =>
      h.call("wallet.accounts", { walletId, groupIndex, template, network }, session);
    const master = HDKey.fromMasterSeed(
      await seedFromEntropy(entropyFromMnemonic(MNEMONIC), "", subtlePbkdf2),
    );
    try {
      const evm = ok(await accounts(1, "evm.bip44", "eip155:1"));
      const expected = master.derive("m/44'/60'/0'/0/1").publicKey!;
      expect(strField(evm, "address")).toBe(evmAddressFromPublicKey(expected));
      const sol = ok(
        await accounts(2, "solana.bip44-change", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"),
      );
      const slip = Slip10.fromMasterSeed(
        await seedFromEntropy(entropyFromMnemonic(MNEMONIC), "", subtlePbkdf2),
      );
      try {
        const node = slip.derive("m/44'/501'/2'/0'");
        try {
          expect(strField(sol, "address")).toBe(
            solanaAddressFromPublicKey(ed25519.getPublicKey(node.privateKey)),
          );
        } finally {
          wipe(node.privateKey);
        }
      } finally {
        wipe(slip.privateKey);
      }
      const tron = ok(await accounts(0, "tron.bip44", "tron:728126428"));
      const tronPub = master.derive("m/44'/195'/0'/0/0").publicKey!;
      expect(strField(tron, "address")).toBe(tronAddressFromPublicKey(tronPub));
    } finally {
      master.wipePrivateData();
    }
    // Group 3 is a hardened step the card never cached; EVM group 3 stays public
    // (the group index is the unhardened account index under m/44'/60'/0').
    await expect(
      errCode(accounts(3, "solana.bip44-change", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")),
    ).resolves.toBe("device-required");
    await expect(
      errCode(accounts(3, "btc.bip84", "bip122:000000000019d6689c085ae165831e93")),
    ).resolves.toBe("device-required");
  });

  it("importing the same seed as a mnemonic wallet is already-exists", async () => {
    const { h, session } = await setup();
    const code = await errCode(
      h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC) }, session),
    );
    expect(code).toBe("already-exists");
  });

  it("wallet.delete removes the card wallet record, never touching cards", async () => {
    const { h, session } = await setup();
    ok(await h.call("wallet.delete", { walletId, verify: verifyPasskey() }, session));
    const image = await h.store.load();
    expect(image.records.filter((r) => r.id === walletId)).toHaveLength(0);
    const wallets = await walletsOf(h, session);
    expect(wallets.some((w) => w.walletId === walletId)).toBe(false);
    // The passkey wallet is untouched.
    expect(wallets).toHaveLength(1);
  });

  it("a card wallet never enters a backup and a restore never creates one", async () => {
    const { h, session } = await setup();
    const backupPasskey = () => ({
      kind: "passkey" as const,
      ceremony: "host" as const,
      credentialId: utf8ToBytes("backup-1"),
      prfBackup: new Uint8Array(32).fill(9),
    });
    ok(
      await h.call(
        "backup.enable",
        { verify: verifyPasskey(), factors: [backupPasskey()] },
        session,
      ),
    );
    const updated = ok(await h.call("backup.update", null, session));
    const b = createHarness();
    await b.settle();
    const restored = ok(
      await b.call("backup.restore", {
        envelope: strField(updated, "envelope"),
        backupFactor: backupPasskey(),
        factor: {
          kind: "passkey" as const,
          credentialId: utf8ToBytes("restored-1"),
          prf: new Uint8Array(32).fill(5),
        },
      }),
    );
    const wallets = arrField(restored, "wallets");
    expect(wallets).toHaveLength(1);
    const image = await b.store.load();
    expect(image.records.some((r) => r.kind === CARD_WALLET_KIND)).toBe(false);
  });

  it("card.* methods answer unsupported on a host without a card reader", async () => {
    const { h, session } = await setup();
    await expect(
      errCode(h.call("card.begin", { op: { kind: "status" }, verify: verifyPasskey() }, session)),
    ).resolves.toBe("unsupported");
    await expect(errCode(h.call("card.step", { opId: "00".repeat(16) }, session))).resolves.toBe(
      "unsupported",
    );
    await expect(errCode(h.call("card.cancel", { opId: "00".repeat(16) }, session))).resolves.toBe(
      "unsupported",
    );
  });

  it("a malformed sealed body latches the vault corrupted at reconcile", async () => {
    const { h, session } = await setup();
    const dek = await sessionDek(h);
    try {
      const image = await h.store.load();
      const record = planted(image.records, walletId);
      const forged = sealRecord(
        sealer,
        dek,
        CARD_WALLET_KIND,
        walletId,
        record.header,
        utf8ToBytes(`{"master":"${"00".repeat(33)}","nodes":{},"ed25519":{},"ephemerals":{}}`),
      );
      await h.store.commit(
        withManifest(sealer, image, [{ op: "put-record", record: forged }], dek),
      );
    } finally {
      dek.wipe();
    }
    await h.settle();
    const status = ok(await h.call("status", null, session)) as Record<string, ProtocolValue>;
    expect(status["vault"]).toStrictEqual({ status: "corrupted" });
  });
});

/* vectors/vault/card-wallet.json (scripts/vectors/card-wallet.ts): the canonical encodings parse
 * and re-encode byte for byte, and every rejection case fails its invariant. */
describe("card-wallet record vectors", () => {
  const vector = loadVectors("vault/card-wallet.json") as {
    walletId: string;
    header: { input: CardWalletHeader; text: string };
    body: { input: CardWalletBody; text: string };
    rejects: Array<{ name: string; side: "header" | "body"; text: string }>;
  };

  it("parses the canonical header and re-encodes it byte-exactly", () => {
    expect(parseCardWalletHeader(vector.header.text)).toStrictEqual(vector.header.input);
    expect(encodeCardWalletHeader(vector.header.input)).toBe(vector.header.text);
    expect(vector.header.input.walletId).toBe(vector.walletId);
  });

  it("parses the canonical body and re-encodes it byte-exactly", () => {
    expect(parseCardWalletBody(vector.body.text, vector.walletId)).toStrictEqual(vector.body.input);
    expect(encodeCardWalletBody(vector.body.input)).toBe(vector.body.text);
  });

  const parsers = {
    header: (text: string) => parseCardWalletHeader(text),
    body: (text: string) => parseCardWalletBody(text, vector.walletId),
  };
  const codeOf = (call: () => unknown): string => {
    try {
      call();
    } catch (error) {
      return error instanceof KernelError ? error.code : "not a KernelError";
    }
    return "no error";
  };

  it.each(vector.rejects.map((entry) => [entry.name, entry] as const))(
    "rejects %s",
    (_name, entry) => {
      expect(codeOf(() => parsers[entry.side](entry.text))).toBe("integrity");
    },
  );
});
