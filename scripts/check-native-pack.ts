/// <reference types="node" />
import { spawnSync } from "node:child_process";

/**
 * The file paths of `npm pack --dry-run --json` — npm is what the publish workflow packs with, so
 * its view of `files` plus nested `.npmignore` files is the one that ships.
 */
export function packList(output: string): string[] {
  const parsed: unknown = JSON.parse(output);
  const first: unknown = Array.isArray(parsed) ? parsed.at(0) : undefined;
  if (typeof first !== "object" || first === null || !("files" in first)) {
    return [];
  }
  const { files } = first;
  if (!Array.isArray(files)) {
    return [];
  }
  return files.flatMap((file: unknown) =>
    typeof file === "object" && file !== null && "path" in file && typeof file.path === "string"
      ? [file.path]
      : [],
  );
}

const REQUIRED = [
  "WalletNative.podspec",
  "react-native.config.js",
  "kernel/generated/kernel-entry.js",
  "kernel/generated/kernel.manifest.json",
  "scripts/compile-kernel.mjs",
  "android/build.gradle",
  "android/CMakeLists.txt",
  "android/consumer-rules.pro",
  "nitrogen/generated/android/WalletNative+autolinking.gradle",
  "cpp/host/HybridKernelHost.cpp",
  "dist/index.mjs",
  "dist/index.d.mts",
  "LICENSE-MIT",
  "LICENSE-APACHE",
] as const;

const FORBIDDEN: ReadonlyArray<{ test: (path: string) => boolean; label: string }> = [
  { test: (p) => p.startsWith("android/build/"), label: "android/build/" },
  { test: (p) => p.startsWith("android/.cxx/"), label: "android/.cxx/" },
  { test: (p) => p.split("/").includes(".gradle"), label: "**/.gradle/" },
  { test: (p) => p.startsWith("tests/"), label: "tests/" },
  { test: (p) => p.startsWith("kernel/") && p.endsWith(".ts"), label: "kernel/*.ts" },
  { test: (p) => p.split("/").includes("node_modules"), label: "**/node_modules/" },
];

/**
 * Native-pack contents check: the `@qntx/wallet-native` tarball must carry everything a consumer's
 * Gradle/CMake/pod build needs and nothing produced by local builds. Kernel TypeScript sources are
 * compiled into `kernel-entry.js` — they must never ship as `kernel/*.ts`.
 */
export function checkNativePack(files: string[]): string[] {
  const errors: string[] = [];
  const set = new Set(files);
  for (const path of REQUIRED) {
    if (!set.has(path)) {
      errors.push(`missing ${path}`);
    }
  }
  if (!files.some((p) => p.startsWith("android/") && p.endsWith(".kt"))) {
    errors.push("missing android Kotlin sources (*.kt)");
  }
  for (const { test, label } of FORBIDDEN) {
    for (const path of files) {
      if (test(path)) {
        errors.push(`unexpected ${label}: ${path}`);
      }
    }
  }
  return errors;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? ".";
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (result.status === 0) {
    const errors = checkNativePack(packList(result.stdout));
    for (const error of errors) {
      console.error(`check-native-pack: ${error}`);
    }
    if (errors.length > 0) {
      process.exitCode = 1;
    } else {
      console.log("check-native-pack: tarball contents verified");
    }
  } else {
    console.error(`check-native-pack: npm pack --dry-run failed\n${result.stderr}`);
    process.exitCode = 1;
  }
}
