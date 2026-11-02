import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vite-plus/test";

import { encodeSparkAddress } from "@qntx/spark";

import { AddressBookController } from "../src/addresses/controller.ts";
import { AddressBookError } from "../src/addresses/errors.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const EVM = "0x52908400098527886E0F7030069857D2E4169EE7";
const SOLANA = "11111111111111111111111111111111";
const BTC_MAIN = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const BTC_TEST = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const SPARK = encodeSparkAddress({
  network: "regtest",
  identityPublicKey: secp256k1.getPublicKey(new Uint8Array(32).fill(9), true),
});

function book(shared?: { collections: Map<string, Map<string, Uint8Array>> }) {
  const backing = shared ?? { collections: new Map<string, Map<string, Uint8Array>>() };
  let n = 0;
  const warnings: string[] = [];
  const controller = new AddressBookController({
    openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
    random: (len) => {
      n += 1;
      return new Uint8Array(len).fill(n);
    },
    now: () => 1000 + n,
    logger: { warn: (m) => warnings.push(m) },
  });
  return { controller, backing, warnings };
}

const category = async (run: Promise<unknown>): Promise<string> =>
  run.then(
    () => "resolved",
    (error: unknown) => (error instanceof AddressBookError ? error.category : String(error)),
  );

describe("AddressBookController", () => {
  it("adds, renames and removes entries", async () => {
    const { controller } = book();
    await controller.init();
    const added = await controller.add({ name: "  Alice  ", family: "evm", address: EVM });
    expect(added).toMatchObject({ name: "Alice", family: "evm", address: EVM });
    expect(added.createdAt).toBe(added.updatedAt);

    const renamed = await controller.rename(added.id, "Alice B");
    expect(renamed.name).toBe("Alice B");
    expect(renamed.updatedAt).toBeGreaterThan(added.updatedAt);
    expect(controller.getState().entries[added.id]?.name).toBe("Alice B");

    await controller.remove(added.id);
    expect(controller.getState().entries).toStrictEqual({});
  });

  it("normalizes EVM addresses to EIP-55", async () => {
    const { controller } = book();
    await controller.init();
    const entry = await controller.add({ name: "a", family: "evm", address: EVM.toLowerCase() });
    expect(entry.address).toBe(EVM);
  });

  it("accepts every family, bitcoin on mainnet and testnet", async () => {
    const { controller } = book();
    await controller.init();
    const entries = await Promise.all([
      controller.add({ name: "sol", family: "solana", address: SOLANA }),
      controller.add({ name: "main", family: "bitcoin", address: BTC_MAIN }),
      controller.add({ name: "test", family: "bitcoin", address: BTC_TEST }),
      controller.add({ name: "spark", family: "spark", address: SPARK }),
    ]);
    expect(entries.map((e) => e.address)).toStrictEqual([SOLANA, BTC_MAIN, BTC_TEST, SPARK]);
  });

  it.each([
    ["evm", "0x123"],
    ["evm", "not an address"],
    ["solana", EVM],
    ["bitcoin", EVM],
    ["bitcoin", "bc1qinvalid"],
    ["spark", BTC_MAIN],
  ] as const)("rejects an invalid %s address %s", async (family, address) => {
    const { controller } = book();
    await controller.init();
    await expect(category(controller.add({ name: "x", family, address }))).resolves.toBe(
      "invalid-input",
    );
  });

  it("rejects bad names, duplicates and unknown ids", async () => {
    const { controller } = book();
    await controller.init();
    await expect(
      category(controller.add({ name: "   ", family: "evm", address: EVM })),
    ).resolves.toBe("invalid-input");
    await expect(
      category(controller.add({ name: "x".repeat(33), family: "evm", address: EVM })),
    ).resolves.toBe("invalid-input");
    const first = await controller.add({ name: "a", family: "evm", address: EVM });
    await expect(
      category(controller.add({ name: "b", family: "evm", address: EVM.toLowerCase() })),
    ).resolves.toBe("duplicate");
    await expect(category(controller.rename(first.id, ""))).resolves.toBe("invalid-input");
    await expect(category(controller.rename("contact-x", "n"))).resolves.toBe("not-found");
    await expect(category(controller.remove("contact-x"))).resolves.toBe("not-found");
  });

  it("persists across a lock and unlock, and clears memory on lock", async () => {
    const { controller, backing } = book();
    await controller.init();
    const entry = await controller.add({ name: "Alice", family: "evm", address: EVM });
    controller.lock();
    expect(controller.getState().entries).toStrictEqual({});
    await expect(
      category(controller.add({ name: "b", family: "solana", address: SOLANA })),
    ).resolves.toBe("locked");

    const reopened = book(backing).controller;
    await reopened.init();
    expect(reopened.getState().entries[entry.id]).toStrictEqual(entry);
  });
});
