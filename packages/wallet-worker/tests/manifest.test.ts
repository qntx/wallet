import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { SPARK_WASM_INTEGRITY } from "@qntx/spark-wasm/browser";
import { SPARK_ABI_VERSION } from "@qntx/spark/crypto";

import { VAULT_FORMAT } from "../../wallet-kernel/src/vault/store.ts";
import { PROTOCOL_VERSION } from "../../wallet/src/protocol/index.ts";
import { kernelManifest, parseLockfile } from "../scripts/kernel-manifest.ts";

const packageDir = join(import.meta.dirname, "..");
const root = join(packageDir, "..", "..");

const kernelPkg = JSON.parse(
  readFileSync(join(root, "packages/wallet-kernel/package.json"), "utf8"),
) as { dependencies: Record<string, string> };
const workerPkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
  devDependencies: Record<string, string>;
};
const sparkWasmVersion = workerPkg.devDependencies["@qntx/spark-wasm"];
if (sparkWasmVersion === undefined) {
  throw new Error("wallet-worker has no @qntx/spark-wasm dependency");
}
const backendDependencies: Record<string, string> = { "@qntx/spark-wasm": sparkWasmVersion };
const lockPackages = ((
  parseLockfile(readFileSync(join(root, "bun.lock"), "utf8")) as { packages?: unknown }
).packages ?? {}) as Record<string, unknown>;

const bundles = [
  { file: "kernel.worker.js", bytes: new Uint8Array([0xde, 0xad]) },
  { file: "kernel.node.js", bytes: new Uint8Array([0xbe, 0xef]) },
];

const backends = {
  spark: { abiVersion: SPARK_ABI_VERSION, wasmIntegrity: SPARK_WASM_INTEGRITY },
} as const;

describe("kernel manifest", () => {
  it("records the source constants, pinned versions, integrities and bundle hashes", () => {
    const manifest = kernelManifest({
      dependencies: kernelPkg.dependencies,
      backendDependencies,
      backends,
      lockPackages,
      bundles,
      protocol: PROTOCOL_VERSION,
      vaultFormat: VAULT_FORMAT,
    });
    expect(manifest.protocol).toBe(PROTOCOL_VERSION);
    expect(manifest.vaultFormat).toBe(VAULT_FORMAT);
    // Every external kernel dependency plus the host's backend packages are listed once, sorted
    // by name, pinned version and a sha512 integrity; the workspace package @qntx/wallet is
    // bundled source, not a library.
    expect(manifest.libraries.map(({ name }) => name)).toStrictEqual(
      [...Object.keys(kernelPkg.dependencies), "@qntx/spark-wasm"]
        .filter((name) => name !== "@qntx/wallet")
        .toSorted((a, b) => a.localeCompare(b)),
    );
    const expectedVersions: Record<string, string> = {
      ...kernelPkg.dependencies,
      ...backendDependencies,
    };
    for (const lib of manifest.libraries) {
      expect(lib.version).toBe(expectedVersions[lib.name]);
      expect(lib.integrity).toMatch(/^sha512-/);
    }
    // The spark backend's pins: the ABI version createSparkSigner checks and the sha256
    // artifact hash the host loaders verify.
    expect(manifest.backends).toStrictEqual({
      spark: { abiVersion: SPARK_ABI_VERSION, wasmIntegrity: SPARK_WASM_INTEGRITY },
    });
    expect(manifest.bundles).toStrictEqual(
      bundles.map(({ file, bytes }) => ({
        file,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })),
    );
  });

  it("rejects a dependency that is not exactly pinned", () => {
    expect(() =>
      kernelManifest({
        dependencies: { ...kernelPkg.dependencies, "@qntx/nostr": "^0.14.0" },
        backendDependencies,
        backends,
        lockPackages,
        bundles,
        protocol: PROTOCOL_VERSION,
        vaultFormat: VAULT_FORMAT,
      }),
    ).toThrow(/exact versions/);
  });

  it("rejects a backend package that is not exactly pinned", () => {
    expect(() =>
      kernelManifest({
        dependencies: kernelPkg.dependencies,
        backendDependencies: { "@qntx/spark-wasm": "^0.2.0" },
        backends,
        lockPackages,
        bundles,
        protocol: PROTOCOL_VERSION,
        vaultFormat: VAULT_FORMAT,
      }),
    ).toThrow(/exact versions/);
  });

  it("rejects a pin that disagrees with bun.lock", () => {
    expect(() =>
      kernelManifest({
        dependencies: { ...kernelPkg.dependencies, "@qntx/nostr": "0.14.1" },
        backendDependencies,
        backends,
        lockPackages,
        bundles,
        protocol: PROTOCOL_VERSION,
        vaultFormat: VAULT_FORMAT,
      }),
    ).toThrow(/bun.lock resolves/);
  });
});
