/// <reference types="node" />
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Out-of-repo consumer acceptance for `@qntx/wallet-native`: pack the unpublished workspace
 * packages into tarballs, scaffold a plain Expo app in a temp dir (no `patchedDependencies` — the
 * Nitro patch must not be needed), prebuild + build iOS/Android Release, run the smoke on a booted
 * iOS simulator, and verify the vault's backup-exclusion xattr and the APK's native libs. Not part
 * of CI. Run from the repo root: `bun run native:consumer`.
 */

const ROOT = process.cwd();
const BUNDLE_ID = "org.qntx.wallet.consumer";
const CONSUMER = join(ROOT, "packages/wallet-native/tests/consumer");
const TARBALL_PACKAGES = ["wallet-chains", "wallet", "wallet-native"] as const;

type Run = {
  cmd: string[];
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
};

const log = (line: string): void => console.log(`native-consumer: ${line}`);

function splitCmd(cmd: string[]): { bin: string; args: string[] } {
  const [bin, ...args] = cmd;
  if (bin === undefined) {
    throw new Error("empty command");
  }
  return { bin, args };
}

function runSync({ cmd, cwd, env }: Run): string {
  const { bin, args } = splitCmd(cmd);
  const result = spawnSync(bin, args, {
    cwd: cwd ?? ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(
      `${cmd.join(" ")} failed (${result.status ?? "signal"})\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`,
    );
  }
  return result.stdout;
}

/** Streams output live (long builds) and returns the exit code. */
async function runStreamed({ cmd, cwd, env }: Run): Promise<number> {
  const { bin, args } = splitCmd(cmd);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: cwd ?? ROOT,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function must({ cmd, cwd, env }: Run): Promise<void> {
  const code = await runStreamed({ cmd, cwd, env });
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} exited ${code}`);
  }
}

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

type SimDevice = { udid: string; name: string; isAvailable: boolean; state: string };

function isSimDevice(value: unknown): value is SimDevice {
  return (
    typeof value === "object" &&
    value !== null &&
    "udid" in value &&
    typeof value.udid === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "isAvailable" in value &&
    typeof value.isAvailable === "boolean" &&
    "state" in value &&
    typeof value.state === "string"
  );
}

/** `--simulator <udid>`, else the first booted iPhone, else boot the first available one. */
function simulatorUdid(): string {
  const simArg = process.argv.indexOf("--simulator");
  const pinned = simArg === -1 ? undefined : process.argv[simArg + 1];
  if (pinned !== undefined) {
    return pinned;
  }
  const parsed: unknown = JSON.parse(
    runSync({ cmd: ["xcrun", "simctl", "list", "devices", "available", "-j"] }),
  );
  if (typeof parsed !== "object" || parsed === null || !("devices" in parsed)) {
    throw new Error("simctl list returned unexpected JSON");
  }
  const { devices } = parsed;
  if (typeof devices !== "object" || devices === null) {
    throw new Error("simctl list returned unexpected JSON");
  }
  let shutdown: SimDevice | undefined;
  for (const group of Object.values(devices)) {
    if (!Array.isArray(group)) {
      continue;
    }
    for (const device of group) {
      if (!isSimDevice(device) || !device.isAvailable || !device.name.includes("iPhone")) {
        continue;
      }
      if (device.state === "Booted") {
        return device.udid;
      }
      shutdown ??= device;
    }
  }
  if (shutdown === undefined) {
    throw new Error("no iOS simulator device found");
  }
  runSync({ cmd: ["xcrun", "simctl", "boot", shutdown.udid] });
  return shutdown.udid;
}

const enrollBiometrics = (udid: string): void => {
  spawnSync(
    "xcrun",
    ["devicectl", "device", "settings", "biometrics", "--device", udid, "--enable"],
    { stdio: "inherit" },
  );
};

const matchBiometrics = (udid: string): void => {
  spawnSync(
    "xcrun",
    ["devicectl", "device", "simulate", "biometrics", "--device", udid, "--success"],
    { stdio: "ignore" },
  );
};

type SmokeResult = {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail: string }>;
};

function isSmokeStep(value: unknown): value is { name: string; ok: boolean; detail: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "ok" in value &&
    typeof value.ok === "boolean" &&
    "detail" in value &&
    typeof value.detail === "string"
  );
}

function parseSmokeResult(text: string): SmokeResult {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("ok" in parsed) ||
    typeof parsed.ok !== "boolean" ||
    !("steps" in parsed) ||
    !Array.isArray(parsed.steps)
  ) {
    throw new Error("consumer-result.json has unexpected shape");
  }
  const steps = parsed.steps.map((step: unknown) => {
    if (!isSmokeStep(step)) {
      throw new Error("consumer-result.json has unexpected shape");
    }
    return step;
  });
  return { ok: parsed.ok, steps };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "qntx-consumer-"));
  const app = join(dir, "app");
  log(`workdir ${dir}`);

  // 1. Tarballs for the unpublished (or under-test) workspace packages.
  const tarballs = new Map<string, string>();
  for (const name of TARBALL_PACKAGES) {
    runSync({
      cmd: ["bun", "pm", "pack", "--destination", dir],
      cwd: join(ROOT, "packages", name),
    });
    const packed = readdirSync(dir).find(
      (f) => f.startsWith(`qntx-${name}-`) && f.endsWith(".tgz"),
    );
    if (packed === undefined) {
      throw new Error(`bun pm pack produced no tarball for @qntx/${name}`);
    }
    const tgz = join(dir, packed);
    tarballs.set(`@qntx/${name}`, tgz);
    log(`packed @qntx/${name}`);
  }

  // 2. Scaffold the consumer app.
  cpSync(CONSUMER, app, { recursive: true });
  const manifestPath = join(app, "package.json");
  let manifest = readFileSync(manifestPath, "utf8");
  for (const [name, tarball] of tarballs) {
    manifest = manifest.replaceAll(`"TARBALL:${name}"`, `"file:${tarball}"`);
  }
  writeFileSync(manifestPath, manifest);
  await must({ cmd: ["bun", "install"], cwd: app });
  log("installed (no patchedDependencies)");

  // 3. Prebuild + pods.
  await must({ cmd: ["bunx", "expo", "prebuild", "--clean"], cwd: app });
  await must({
    cmd: ["pod", "install", "--project-directory=ios"],
    cwd: app,
    env: { PATH: `/usr/bin:/usr/local/bin:/opt/homebrew/bin:${process.env["PATH"] ?? ""}` },
  });
  log("prebuild + pod install done");

  // 4. iOS Release build for the simulator.
  await must({
    cmd: [
      "xcodebuild",
      "-workspace",
      "ios/WalletConsumer.xcworkspace",
      "-scheme",
      "WalletConsumer",
      "-configuration",
      "Release",
      "-destination",
      "generic/platform=iOS Simulator",
      "-derivedDataPath",
      join(dir, "derived"),
      // Signing must not be disabled: an unsigned binary cannot touch the
      // keychain (every SecItem call fails errSecMissingEntitlement -34018,
      // surfaced by the kernel as `unavailable`). Xcode's default ad-hoc
      // "Sign to Run Locally" identity is sufficient.
      "build",
    ],
    cwd: app,
    env: { PATH: `/usr/bin:/usr/local/bin:/opt/homebrew/bin:${process.env["PATH"] ?? ""}` },
  });
  const appBundle = join(dir, "derived/Build/Products/Release-iphonesimulator/WalletConsumer.app");
  if (!existsSync(appBundle)) {
    throw new Error("Release-iphonesimulator/WalletConsumer.app not found");
  }
  log(`built ${appBundle}`);

  // 5. Install + launch on the simulator; approve Face ID sheets while polling.
  const udid = simulatorUdid();
  spawnSync("xcrun", ["simctl", "uninstall", udid, BUNDLE_ID], { stdio: "ignore" });
  runSync({ cmd: ["xcrun", "simctl", "install", udid, appBundle] });
  enrollBiometrics(udid);
  runSync({ cmd: ["xcrun", "simctl", "launch", udid, BUNDLE_ID] });
  log(`sim ${udid} launched; polling consumer-result.json`);

  const deadline = Date.now() + 120_000;
  let dataContainer = "";
  const readResult = (): string => {
    try {
      dataContainer = runSync({
        cmd: ["xcrun", "simctl", "get_app_container", udid, BUNDLE_ID, "data"],
      }).trim();
    } catch {
      return "";
    }
    const file = join(dataContainer, "Documents", "consumer-result.json");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  const poll = async (): Promise<string> => {
    matchBiometrics(udid);
    const found = readResult();
    if (found !== "" || Date.now() >= deadline) {
      return found;
    }
    await sleep(3000);
    return poll();
  };
  const simResult = await poll();
  if (simResult === "") {
    throw new Error("consumer-result.json never appeared");
  }

  // 6. V3 backup exclusion on the vault directory (created during the smoke).
  const vaultDir = join(dataContainer, "Library", "Application Support", "qntx-wallet");
  const xattr = spawnSync("xattr", ["-l", vaultDir], { encoding: "utf8" });
  writeFileSync(join(dir, "vault-xattr.txt"), `${xattr.stdout}${xattr.stderr}`);
  log(`xattr -l ${vaultDir}\n${xattr.stdout}${xattr.stderr}`.trim());
  if (
    !`${xattr.stdout}${xattr.stderr}`.includes("com.apple.metadata:com_apple_backup_excludeItem")
  ) {
    throw new Error("vault directory is not excluded from backup");
  }

  // 7. The simulator run is the verdict: a failing smoke is a hard failure.
  const resultFile = join(dir, "consumer-result.json");
  writeFileSync(resultFile, simResult);
  const result = parseSmokeResult(simResult);
  log(`consumer-result.json → ${resultFile}`);
  log(simResult);
  if (!result.ok) {
    throw new Error("smoke failed — see consumer-result.json");
  }

  // 8. Android Release build + native libs check.
  const androidEnv = {
    JAVA_HOME: "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    ANDROID_HOME: `${process.env["HOME"] ?? ""}/Library/Android/sdk`,
  };
  await must({
    cmd: ["./gradlew", "assembleRelease", "--console=plain", "-q"],
    cwd: join(app, "android"),
    env: androidEnv,
  });
  const apk = join(app, "android/app/build/outputs/apk/release/app-release.apk");
  const listing = runSync({ cmd: ["unzip", "-lv", apk] });
  writeFileSync(join(dir, "apk-unzip-lv.txt"), listing);
  const required = [
    "lib/arm64-v8a/libWalletNative.so",
    "lib/arm64-v8a/libNostrNative.so",
    "lib/arm64-v8a/libSparkNative.so",
    "lib/arm64-v8a/libqntx_spark.so",
  ];
  for (const lib of required) {
    if (!listing.includes(lib)) {
      throw new Error(`APK is missing ${lib}`);
    }
  }
  log("android release built; arm64-v8a native libs present");
  log(`PASS — all artifacts under ${dir}`);
}

try {
  await main();
} catch (error: unknown) {
  console.error(
    `native-consumer: FAILED — ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
