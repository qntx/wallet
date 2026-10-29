/// <reference types="node" />
/**
 * Writes `dist/kernel.manifest.json` after the kernel bundles: the protocol version, the vault
 * format, every external runtime dependency of `@qntx/wallet-kernel` with its bun.lock integrity,
 * and the SHA-256 of each bundle. Fails (non-zero exit) when a kernel dependency is not an exact
 * pin or disagrees with bun.lock — the manifest must never record a build the pins do not cover.
 *
 * Run from the package root: bun scripts/kernel-manifest.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SPARK_WASM_INTEGRITY } from "@qntx/spark-wasm/browser";
import { SPARK_ABI_VERSION } from "@qntx/spark/crypto";

import { VAULT_FORMAT } from "../../wallet-kernel/src/vault/store.ts";
import { PROTOCOL_VERSION } from "../../wallet/src/protocol/index.ts";
import {
  isRecord,
  lockPackages,
  manifestBundles,
  manifestLibraries,
  parseLockfile,
  stringMap,
} from "../../../scripts/kernel-manifest.ts";

export { parseLockfile };

export type KernelManifest = {
  readonly protocol: number;
  readonly vaultFormat: number;
  readonly libraries: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
    readonly integrity: string;
  }>;
  /** Host-injected crypto backends: ABI pin and the artifact hash the loader verifies. */
  readonly backends: {
    readonly spark: {
      readonly abiVersion: number;
      readonly wasmIntegrity: string;
    };
  };
  readonly bundles: ReadonlyArray<{ readonly file: string; readonly sha256: string }>;
};

/**
 * Builds the manifest. `dependencies` is the kernel package's dependency table, `lockPackages` the
 * `packages` section of a parsed bun.lock, `bundles` the emitted worker files.
 */
export function kernelManifest(input: {
  readonly dependencies: Readonly<Record<string, string>>;
  /** Host-side backend packages (e.g. `@qntx/spark-wasm`); same exact-pin and integrity rules. */
  readonly backendDependencies: Readonly<Record<string, string>>;
  readonly backends: {
    readonly spark: {
      readonly abiVersion: number;
      readonly wasmIntegrity: string;
    };
  };
  readonly lockPackages: Readonly<Record<string, unknown>>;
  readonly bundles: ReadonlyArray<{ readonly file: string; readonly bytes: Uint8Array }>;
  readonly protocol: number;
  readonly vaultFormat: number;
}): KernelManifest {
  return {
    protocol: input.protocol,
    vaultFormat: input.vaultFormat,
    backends: input.backends,
    libraries: manifestLibraries({
      dependencies: input.dependencies,
      backendDependencies: input.backendDependencies,
      lockPackages: input.lockPackages,
    }),
    bundles: manifestBundles(input.bundles),
  };
}

if (import.meta.main) {
  const packageDir = join(import.meta.dirname, "..");
  const root = join(packageDir, "..", "..");
  const kernelPkg: unknown = JSON.parse(
    readFileSync(join(root, "packages/wallet-kernel/package.json"), "utf8"),
  );
  const workerPkg: unknown = JSON.parse(
    readFileSync(join(root, "packages/wallet-worker/package.json"), "utf8"),
  );
  const workerDevDeps = stringMap(isRecord(workerPkg) ? workerPkg["devDependencies"] : undefined);
  const manifest = kernelManifest({
    dependencies: stringMap(isRecord(kernelPkg) ? kernelPkg["dependencies"] : undefined),
    backendDependencies: { "@qntx/spark-wasm": workerDevDeps["@qntx/spark-wasm"] ?? "" },
    backends: { spark: { abiVersion: SPARK_ABI_VERSION, wasmIntegrity: SPARK_WASM_INTEGRITY } },
    lockPackages: lockPackages(parseLockfile(readFileSync(join(root, "bun.lock"), "utf8"))),
    bundles: readdirSync(join(packageDir, "dist"))
      .filter((file) => file.startsWith("kernel.") || file.endsWith(".js"))
      .filter((file) => file.endsWith(".js"))
      .map((file) => ({
        file,
        bytes: readFileSync(join(packageDir, "dist", file)),
      })),
    protocol: PROTOCOL_VERSION,
    vaultFormat: VAULT_FORMAT,
  });
  const out = join(packageDir, "dist", "kernel.manifest.json");
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${out}`);
}
