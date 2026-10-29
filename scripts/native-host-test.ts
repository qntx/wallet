import { pbkdf2Sync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
/// <reference types="node" />
/**
 * Build and run the kernel-runtime host test suite
 * (packages/wallet-native/tests/host/RuntimeHostTest.cpp) against the Hermes macOS slice from the
 * harness app's Pods.
 *
 * Three binaries: ASan+UBSan+float-cast-overflow (-O1), TSan (-O1) and plain -O2. Every case runs
 * in a fresh process; footprint/timing cases run only on the plain -O2 binary.
 *
 * Prerequisites: `pod install` inside apps/harness/ios (for destroot) and a `bun install` inside
 * apps/harness (for hermes-compiler's hermesc).
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

declare const Bun: {
  spawnSync: (
    cmd: ReadonlyArray<string>,
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdout: "pipe" | "inherit";
      stderr: "pipe" | "inherit";
      timeout?: number;
    },
  ) => {
    exitCode: number;
    stdout: { toString: () => string };
    stderr: { toString: () => string };
  };
};

const root = fileURLToPath(new URL("..", import.meta.url));
const harness = resolve(root, "apps/harness");
const moduleDir = resolve(root, "packages/wallet-native");
const cppDir = resolve(moduleDir, "cpp");
const buildDir = resolve(moduleDir, "tests/host/build");
const destroot = resolve(harness, "ios/Pods/hermes-engine/destroot");
const frameworksDir = resolve(destroot, "Library/Frameworks/macosx");
const hermesFramework = resolve(frameworksDir, "hermesvm.framework");

if (!existsSync(hermesFramework)) {
  throw new Error(
    `hermesvm.framework macOS slice missing at ${hermesFramework}.\n` +
      "Run `pod install` in apps/harness/ios first.",
  );
}

// Regenerate probes.hpp first so the kernel probe case sees current probes.
{
  const gen = Bun.spawnSync(["bun", "scripts/harness-bundles.ts"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (gen.exitCode !== 0) {
    throw new Error("harness-bundles failed");
  }
}

const hermesc = (() => {
  const require = createRequire(resolve(harness, "package.json"));
  const packageJson = require.resolve("hermes-compiler/package.json");
  const platformDir =
    process.platform === "darwin"
      ? "osx-bin"
      : process.platform === "linux"
        ? "linux64-bin"
        : "win64-bin";
  return resolve(dirname(packageJson), "hermesc", platformDir, "hermesc");
})();

mkdirSync(buildDir, { recursive: true });

// Exercise the shipped compile script — the same one the app's native build
// runs — to produce kernel.hpp for RuntimeHostTest's kernel-bytecode case.
{
  const proc = Bun.spawnSync(
    [
      "node",
      resolve(harness, "node_modules/@qntx/wallet-native/scripts/compile-kernel.mjs"),
      resolve(buildDir, "qntx-kernel"),
      resolve(harness, "node_modules/react-native"),
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (proc.exitCode !== 0) {
    throw new Error("compile-kernel.mjs failed");
  }
}

const runtimeSources = [
  resolve(moduleDir, "tests/host/RuntimeHostTest.cpp"),
  resolve(cppDir, "runtime/KernelBuffer.cpp"),
  resolve(cppDir, "runtime/KernelRuntime.cpp"),
  resolve(cppDir, "runtime/KernelGlobals.cpp"),
  resolve(cppDir, "runtime/platform/KernelPbkdf2.cpp"),
  resolve(cppDir, "host/KernelFile.cpp"),
  resolve(cppDir, "host/Lifecycle.cpp"),
  resolve(moduleDir, "tests/host/HostLifecycle.cpp"),
];
const cxxFlags = [
  "-std=c++20",
  "-Wall",
  "-Wextra",
  "-I",
  resolve(destroot, "include"),
  "-I",
  cppDir,
  // probes.hpp stays with the probe module — the host test embeds the same scripts.
  "-I",
  resolve(harness, "modules/v1-probe/cpp"),
  // kernel.hpp produced by compile-kernel.mjs above.
  "-I",
  resolve(buildDir, "qntx-kernel"),
];
const linkFlags = ["-F", frameworksDir, "-framework", "hermesvm", `-Wl,-rpath,${frameworksDir}`];

const variants: ReadonlyArray<{ name: string; flags: string[]; env: Record<string, string> }> = [
  {
    name: "asan",
    flags: ["-O1", "-fsanitize=address,undefined,float-cast-overflow", "-fno-omit-frame-pointer"],
    // Leak detection is off: the KDF worker thread and its queue are
    // intentionally process-lifetime objects.
    env: { ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0", UBSAN_OPTIONS: "halt_on_error=1" },
  },
  {
    name: "tsan",
    flags: ["-O1", "-fsanitize=thread", "-fno-omit-frame-pointer"],
    env: { TSAN_OPTIONS: "halt_on_error=1" },
  },
  { name: "o2", flags: ["-O2"], env: {} },
];

for (const variant of variants) {
  const binary = resolve(buildDir, `RuntimeHostTest-${variant.name}`);
  const proc = Bun.spawnSync(
    [
      "xcrun",
      "clang++",
      ...cxxFlags,
      ...variant.flags,
      ...runtimeSources,
      ...linkFlags,
      "-o",
      binary,
    ],
    { stdout: "inherit", stderr: "inherit", timeout: 600_000 },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`clang++ failed for variant ${variant.name}`);
  }
  console.log(`built ${binary}`);
}

// Busy-loop bytecode fixture compiled with async break checks.
const busyloopJs = resolve(buildDir, "busyloop.js");
const busyloopHbc = resolve(buildDir, "busyloop.hbc");
writeFileSync(
  busyloopJs,
  "function __send(s){var b=new Uint8Array(s.length);for(var i=0;i<s.length;i++){b[i]=s.charCodeAt(i)&0xff;}__qntx.frames.post(b.buffer);}" +
    '__send("ready");var t=Date.now();while(Date.now()-t<3000){}',
);
{
  const proc = Bun.spawnSync(
    [hermesc, "-emit-binary", "-emit-async-break-check", "-out", busyloopHbc, busyloopJs],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`hermesc failed: ${proc.stderr.toString()}`);
  }
}

// Reference PBKDF2 outputs (node:crypto is the independent oracle).
const utf8 = (s: string): Buffer => Buffer.from(s, "utf8");
const vectorEnv: Record<string, string> = {
  V1_PBKDF2_SHA256_1: pbkdf2Sync(utf8("passwd"), utf8("salt"), 1, 64, "sha256").toString("hex"),
  V1_PBKDF2_SHA256_80000: pbkdf2Sync(utf8("Password"), utf8("NaCl"), 80000, 64, "sha256").toString(
    "hex",
  ),
  V1_PBKDF2_SHA512_UTF8: pbkdf2Sync(
    utf8("pässwörd 🔑"),
    utf8("salt-✓"),
    777,
    48,
    "sha512",
  ).toString("hex"),
};

// Footprint and wall-clock assertions are meaningless under sanitizers — these cases run only on
// the plain -O2 binary. Every other case listed by `<binary> --list` runs on all three binaries, so
// a case added to the C++ map can never drift out of the suite.
const plainOnlyCases = [
  "destroy-busyloop-source",
  "destroy-busyloop-bytecode",
  "timers-cancel",
  "timers-fired",
  "measure-timers-standard",
  "measure-timers-hardened",
];

let passed = 0;
let failed = 0;
const runCase = (
  binary: string,
  testCase: string,
  env: Record<string, string>,
  extraArgs: string[] = [],
): void => {
  const proc = Bun.spawnSync([binary, testCase, ...extraArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env, ...vectorEnv },
    timeout: 240_000,
  });
  const stderr = proc.stderr.toString().trim();
  if (proc.exitCode === 0) {
    passed += 1;
    if (stderr.length > 0) {
      console.log(`  [${testCase}] ${stderr}`);
    }
  } else {
    failed += 1;
    console.error(`  FAIL ${testCase} (exit ${proc.exitCode})`);
    if (stderr.length > 0) {
      console.error(`    ${stderr.split("\n").join("\n    ")}`);
    }
    const stdout = proc.stdout.toString().trim();
    if (stdout.length > 0) {
      console.error(`    stdout: ${stdout.split("\n").join("\n    ")}`);
    }
  }
};

const o2Binary = resolve(buildDir, "RuntimeHostTest-o2");
const listProc = Bun.spawnSync([o2Binary, "--list"], {
  stdout: "pipe",
  stderr: "pipe",
  env: process.env,
});
const listedCases = listProc.stdout
  .toString()
  .split("\n")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
if (listProc.exitCode !== 0 || listedCases.length === 0) {
  throw new Error("RuntimeHostTest --list produced no cases");
}
for (const testCase of plainOnlyCases) {
  if (!listedCases.includes(testCase)) {
    throw new Error(`plainOnlyCases entry not registered in RuntimeHostTest: ${testCase}`);
  }
}
const functionalCases = listedCases.filter((name) => !plainOnlyCases.includes(name));

for (const variant of variants) {
  const binary = resolve(buildDir, `RuntimeHostTest-${variant.name}`);
  console.log(`== ${variant.name} ==`);
  for (const testCase of functionalCases) {
    runCase(binary, testCase, variant.env);
  }
  if (variant.name === "o2") {
    for (const testCase of plainOnlyCases) {
      runCase(binary, testCase, variant.env, testCase.endsWith("bytecode") ? [busyloopHbc] : []);
    }
  }
}

console.log(`host tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
