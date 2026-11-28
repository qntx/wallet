import { base58, base64 } from "@scure/base";
import { address, isOffCurveAddress } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import {
  SNS_MAINNET,
  SNS_NAME_PROGRAM,
  SNS_PRIMARY_PROGRAM,
  SNS_ROOT_DOMAIN,
  lookupSns,
  resolveSns,
  snsDomainKey,
  snsPrimaryDomainKey,
  snsReverseKey,
  snsSolRecordV1Key,
  snsSolRecordV2Key,
} from "../src/names/sns.ts";
import type { NetworkInfo } from "../src/networks/registry.ts";

type Account = { readonly owner: string; readonly data: Uint8Array };
type Store = Map<string, Account>;

const onCurve = (seed: number): Uint8Array => {
  const out = new Uint8Array(32);
  out[0] = seed;
  for (let i = 0; i < 256; i += 1) {
    out[31] = i;
    if (!isOffCurveAddress(address(base58.encode(out)))) {
      return new Uint8Array(out);
    }
  }
  throw new Error("no on-curve test key");
};

const OWNER = onCurve(1);
const OTHER = onCurve(2);
const OWNER_B58 = base58.encode(OWNER);
const OTHER_B58 = base58.encode(OTHER);
const ROOT_BYTES = base58.decode(SNS_ROOT_DOMAIN);
const utf8 = new TextEncoder();

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const registry = (parent: Uint8Array, owner: Uint8Array, payload = new Uint8Array()): Uint8Array =>
  concat(parent, owner, new Uint8Array(32), payload);

const recordV1 = (content: Uint8Array, length = 160): Uint8Array => {
  const out = new Uint8Array(length);
  if (length >= 128) {
    out.set(content.slice(0, 32), 96);
  }
  return out;
};

const validationLength = (validation: number): number =>
  validation === 0 ? 0 : validation === 2 ? 20 : 32;

const recordV2 = (
  content: Uint8Array,
  options: {
    readonly stalenessValidation?: number;
    readonly roaValidation?: number;
    readonly contentLength?: number;
    readonly truncate?: boolean;
  } = {},
): Uint8Array => {
  const stalenessValidation = options.stalenessValidation ?? 0;
  const roaValidation = options.roaValidation ?? 0;
  const contentLength = options.contentLength ?? 32;
  const contentAt = 104 + validationLength(stalenessValidation) + validationLength(roaValidation);
  const out = new Uint8Array(
    options.truncate === true ? contentAt + contentLength - 1 : contentAt + contentLength,
  );
  const view = new DataView(out.buffer);
  view.setUint16(96, stalenessValidation, true);
  view.setUint16(98, roaValidation, true);
  view.setUint32(100, contentLength, true);
  out.set(
    content.slice(0, Math.min(contentLength, Math.max(0, out.length - contentAt))),
    contentAt,
  );
  return out;
};

const cloneStore = (store: Store): Store =>
  new Map(
    [...store].map(([key, account]) => [
      key,
      { owner: account.owner, data: new Uint8Array(account.data) },
    ]),
  );

const accountAt = (store: Store, key: string): Account => {
  const account = store.get(key);
  if (account === undefined) {
    throw new Error(`missing fixture account ${key}`);
  }
  return account;
};

const withMutatedLastByte = (account: Account): Account => {
  const data = new Uint8Array(account.data);
  data[data.length - 1] = ((data.at(-1) ?? 0) + 1) % 256;
  return { owner: account.owner, data };
};

const rpc = (store: Store, fail = false) => ({
  call: async (method: string, params: unknown[]): Promise<unknown> => {
    if (fail) {
      return Promise.reject(new Error("rpc down"));
    }
    expect(method).toBe("getMultipleAccounts");
    const keys = params[0] as string[];
    return Promise.resolve({
      value: keys.map((key) => {
        const account = store.get(key);
        return account === undefined
          ? null
          : {
              owner: account.owner,
              data: [base64.encode(account.data), "base64"],
              executable: false,
              lamports: 1,
              rentEpoch: 0,
            };
      }),
    });
  },
});

const info = (family: NetworkInfo["family"] = "solana"): NetworkInfo => ({
  id: SNS_MAINNET,
  chainId: 0,
  name: "Solana",
  symbol: "SOL",
  decimals: 9,
  family,
  testnet: false,
});

const networks = (
  primary: Store,
  options: {
    readonly independent?: "available" | "unavailable" | "not-needed";
    readonly independentStore?: Store;
    readonly independentFails?: boolean;
    readonly family?: NetworkInfo["family"];
  } = {},
) =>
  ({
    info: () => info(options.family ?? "solana"),
    solanaRpc: () => rpc(primary),
    independentSolanaRpc: () => {
      const kind = options.independent ?? "not-needed";
      if (kind === "available") {
        return {
          kind: "available",
          source: "host",
          client: rpc(options.independentStore ?? primary, options.independentFails === true),
        };
      }
      return { kind };
    },
  }) as never;

const domainKeys = async (name: string) => {
  const labels = name.split(".");
  const [first = "", second] = labels;
  if (second === undefined) {
    const key = await snsDomainKey(first);
    return { key, parent: SNS_ROOT_DOMAIN, parentKey: undefined };
  }
  const parentKey = await snsDomainKey(second);
  return { key: await snsDomainKey(`\0${first}`, parentKey), parent: parentKey, parentKey };
};

const setupForward = async (
  name = "example",
  owner = OWNER,
): Promise<{
  readonly store: Store;
  readonly key: string;
  readonly parent: string;
  readonly parentKey: string | undefined;
  readonly recordV1Key: string;
  readonly recordV2Key: string;
}> => {
  const keys = await domainKeys(name);
  const parentBytes = keys.parentKey === undefined ? ROOT_BYTES : base58.decode(keys.parentKey);
  const store: Store = new Map([
    [keys.key, { owner: SNS_NAME_PROGRAM, data: registry(parentBytes, owner) }],
  ]);
  return {
    store,
    ...keys,
    recordV1Key: await snsSolRecordV1Key(keys.key),
    recordV2Key: await snsSolRecordV2Key(keys.key),
  };
};

const resolve = async (
  store: Store,
  name = "example.sns",
  options: Parameters<typeof networks>[1] = {},
) => resolveSns(networks(store, options), name, SNS_MAINNET);

describe("SNS derivation", () => {
  it("matches the official SDK domain vectors", async () => {
    await expect(snsDomainKey("bonfida")).resolves.toBe(
      "Crf8hzfthWGbGbLTVCiqRqV5MVnbpHB1L9KQMd6gsinb",
    );
    const parent = await snsDomainKey("bonfida");
    await expect(snsDomainKey("\0dex", parent)).resolves.toBe(
      "HoFfFXqFHAC8RP3duuQNzag1ieUwJRBv1HtRNiWFq4Qu",
    );
  });

  it("matches the official SDK record v2 vectors", async () => {
    await expect(snsSolRecordV2Key(await snsDomainKey("domain1"))).resolves.toBe(
      "GBrd6Q53eu1T2PiaQAtm92r3DwxmoGvZ2D6xjtVtN1Qt",
    );
    const parent = await snsDomainKey("domain2");
    await expect(snsSolRecordV2Key(await snsDomainKey("\0sub", parent))).resolves.toBe(
      "A3EFmyCmK5rp73TdgLH8aW49PJ8SJw915arhydRZ6Sws",
    );
  });
});

describe("SNS input and network rules", () => {
  it("refuses .sol with the SRS migration message", async () => {
    const { store } = await setupForward();
    await expect(resolve(store, "example.sol")).rejects.toThrow("SRS migration");
  });

  it("ASCII-lowercases uppercase input", async () => {
    const { store } = await setupForward();
    await expect(resolve(store, "EXAMPLE.SNS")).resolves.toMatchObject({
      name: "example.sns",
      address: OWNER_B58,
    });
  });

  it("refuses unicode labels and three-level names", async () => {
    const { store } = await setupForward();
    await expect(resolve(store, "café.sns")).rejects.toThrow("not a valid SNS name");
    await expect(resolve(store, "deep.sub.example.sns")).rejects.toThrow("not a valid SNS name");
  });

  it("refuses non-mainnet and non-Solana networks", async () => {
    const { store } = await setupForward();
    await expect(resolveSns(networks(store), "example.sns", "solana:devnet")).rejects.toThrow(
      "mainnet",
    );
    await expect(resolve(store, "example.sns", { family: "evm" })).rejects.toThrow("Solana");
  });
});

describe("resolveSns", () => {
  it("resolves a well-formed name account with no records", async () => {
    const { store } = await setupForward();
    await expect(resolve(store)).resolves.toStrictEqual({
      name: "example.sns",
      address: OWNER_B58,
      checks: [],
      risk: [],
    });
  });

  it("throws when the name account is missing", async () => {
    await expect(resolve(new Map())).rejects.toThrow("does not resolve");
  });

  it("refuses an account not owned by the name program", async () => {
    const fixture = await setupForward();
    fixture.store.set(fixture.key, {
      owner: OTHER_B58,
      data: accountAt(fixture.store, fixture.key).data,
    });
    await expect(resolve(fixture.store)).rejects.toThrow("not owned by the name program");
  });

  it("refuses a name account whose parent does not match the derivation", async () => {
    const fixture = await setupForward();
    fixture.store.set(fixture.key, {
      owner: SNS_NAME_PROGRAM,
      data: registry(new Uint8Array(32), OWNER),
    });
    await expect(resolve(fixture.store)).rejects.toThrow("parent");
  });

  it("refuses an off-curve PDA owner", async () => {
    const fixture = await setupForward("example", ROOT_BYTES);
    await expect(resolve(fixture.store)).rejects.toThrow("program-derived");
  });

  it("accepts v1 and v2 records whose content equals the owner", async () => {
    const fixture = await setupForward();
    fixture.store.set(fixture.recordV1Key, { owner: SNS_NAME_PROGRAM, data: recordV1(OWNER) });
    fixture.store.set(fixture.recordV2Key, { owner: SNS_NAME_PROGRAM, data: recordV2(OWNER) });
    await expect(resolve(fixture.store)).resolves.toMatchObject({ address: OWNER_B58 });
  });

  it("refuses a v1 record that points elsewhere or is too short", async () => {
    const mismatch = await setupForward();
    mismatch.store.set(mismatch.recordV1Key, { owner: SNS_NAME_PROGRAM, data: recordV1(OTHER) });
    await expect(resolve(mismatch.store)).rejects.toThrow("v1 points away");

    const short = await setupForward();
    short.store.set(short.recordV1Key, { owner: SNS_NAME_PROGRAM, data: recordV1(OWNER, 127) });
    await expect(resolve(short.store)).rejects.toThrow("malformed SOL record v1");
  });

  it("refuses a v2 record that points elsewhere", async () => {
    const fixture = await setupForward();
    fixture.store.set(fixture.recordV2Key, { owner: SNS_NAME_PROGRAM, data: recordV2(OTHER) });
    await expect(resolve(fixture.store)).rejects.toThrow("v2 points away");
  });

  it("refuses a malformed v2 validation, content length, or truncation", async () => {
    const badValidation = await setupForward();
    badValidation.store.set(badValidation.recordV2Key, {
      owner: SNS_NAME_PROGRAM,
      data: recordV2(OWNER, { stalenessValidation: 9 }),
    });
    await expect(resolve(badValidation.store)).rejects.toThrow("malformed SOL record v2");

    const wrongLength = await setupForward();
    wrongLength.store.set(wrongLength.recordV2Key, {
      owner: SNS_NAME_PROGRAM,
      data: recordV2(OWNER, { contentLength: 31 }),
    });
    await expect(resolve(wrongLength.store)).rejects.toThrow("malformed SOL record v2");

    const truncated = await setupForward();
    truncated.store.set(truncated.recordV2Key, {
      owner: SNS_NAME_PROGRAM,
      data: recordV2(OWNER, { truncate: true }),
    });
    await expect(resolve(truncated.store)).rejects.toThrow("malformed SOL record v2");
  });

  it.each(["key", "recordV1Key", "recordV2Key"] as const)(
    "throws when the independent endpoint disagrees on the %s slot",
    async (slot) => {
      const fixture = await setupForward();
      fixture.store.set(fixture.recordV1Key, { owner: SNS_NAME_PROGRAM, data: recordV1(OWNER) });
      fixture.store.set(fixture.recordV2Key, { owner: SNS_NAME_PROGRAM, data: recordV2(OWNER) });
      const independent = cloneStore(fixture.store);
      const key = fixture[slot];
      independent.set(key, withMutatedLastByte(accountAt(independent, key)));
      await expect(
        resolve(fixture.store, "example.sns", {
          independent: "available",
          independentStore: independent,
        }),
      ).rejects.toThrow("disagree");
    },
  );

  it("flags independent failure or unavailability and adds no check when not needed", async () => {
    const failedFixture = await setupForward();
    const failed = await resolve(failedFixture.store, "example.sns", {
      independent: "available",
      independentFails: true,
    });
    expect(failed.checks).toStrictEqual(["reads-unverified"]);

    const unavailableFixture = await setupForward();
    const unavailable = await resolve(unavailableFixture.store, "example.sns", {
      independent: "unavailable",
    });
    expect(unavailable.checks).toStrictEqual(["reads-unverified"]);

    const hostOnlyFixture = await setupForward();
    const hostOnly = await resolve(hostOnlyFixture.store, "example.sns", {
      independent: "not-needed",
    });
    expect(hostOnly.checks).toStrictEqual([]);
  });
});

const reverseData = (name: string): Uint8Array => {
  const encoded = utf8.encode(name);
  const out = new Uint8Array(96 + 4 + encoded.length);
  new DataView(out.buffer).setUint32(96, encoded.length, true);
  out.set(encoded, 100);
  return out;
};

const setupLookup = async (sub = false, owner = OWNER) => {
  const name = sub ? "sub.example" : "example";
  const fixture = await setupForward(name, owner);
  const ownerB58 = base58.encode(owner);
  const primaryKey = await snsPrimaryDomainKey(ownerB58);
  const primary = new Uint8Array(33);
  primary.set(base58.decode(fixture.key), 1);
  fixture.store.set(primaryKey, { owner: SNS_PRIMARY_PROGRAM, data: primary });
  const reverseKey = await snsReverseKey(fixture.key, fixture.parentKey);
  fixture.store.set(reverseKey, {
    owner: SNS_NAME_PROGRAM,
    data: reverseData(sub ? "\0sub" : "example"),
  });
  let parentReverseKey: string | undefined;
  if (fixture.parentKey !== undefined) {
    parentReverseKey = await snsReverseKey(fixture.parentKey);
    fixture.store.set(parentReverseKey, {
      owner: SNS_NAME_PROGRAM,
      data: reverseData("example"),
    });
  }
  return { ...fixture, ownerB58, primaryKey, reverseKey, parentReverseKey };
};

const lookup = async (
  store: Store,
  owner = OWNER_B58,
  options: Parameters<typeof networks>[1] = {},
) => lookupSns(networks(store, options), owner, SNS_MAINNET);

describe("lookupSns", () => {
  it("returns a verified second-level primary name", async () => {
    const fixture = await setupLookup();
    await expect(lookup(fixture.store)).resolves.toStrictEqual({
      name: "example.sns",
      address: OWNER_B58,
      checks: [],
      risk: [],
    });
  });

  it("returns a verified subdomain primary name", async () => {
    const fixture = await setupLookup(true);
    await expect(lookup(fixture.store)).resolves.toStrictEqual({
      name: "sub.example.sns",
      address: OWNER_B58,
      checks: [],
      risk: [],
    });
  });

  it("returns undefined when there is no primary or no reverse account", async () => {
    await expect(lookup(new Map())).resolves.toBeUndefined();
    const fixture = await setupLookup();
    fixture.store.delete(fixture.reverseKey);
    await expect(lookup(fixture.store)).resolves.toBeUndefined();
  });

  it("does not show a stale primary whose forward owner differs", async () => {
    const fixture = await setupLookup(false, OTHER);
    await expect(lookup(fixture.store, OWNER_B58)).resolves.toBeUndefined();
  });

  it("does not show a reverse payload that fails the label rule", async () => {
    const fixture = await setupLookup();
    fixture.store.set(fixture.reverseKey, {
      owner: SNS_NAME_PROGRAM,
      data: reverseData("Example"),
    });
    await expect(lookup(fixture.store)).resolves.toBeUndefined();
  });

  it("throws when the forward re-resolution disagrees across endpoints", async () => {
    const fixture = await setupLookup();
    fixture.store.set(fixture.recordV1Key, { owner: SNS_NAME_PROGRAM, data: recordV1(OWNER) });
    const independent = cloneStore(fixture.store);
    independent.set(
      fixture.recordV1Key,
      withMutatedLastByte(accountAt(independent, fixture.recordV1Key)),
    );
    await expect(
      lookup(fixture.store, OWNER_B58, { independent: "available", independentStore: independent }),
    ).rejects.toThrow("disagree");
  });

  it("throws when the endpoints disagree on a reverse account", async () => {
    const fixture = await setupLookup();
    const independent = cloneStore(fixture.store);
    independent.set(
      fixture.reverseKey,
      withMutatedLastByte(accountAt(independent, fixture.reverseKey)),
    );
    await expect(
      lookup(fixture.store, OWNER_B58, { independent: "available", independentStore: independent }),
    ).rejects.toThrow("disagree");
  });
});
