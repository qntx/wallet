/**
 * Card-surfaces driver: `bun scripts/card-surfaces-run.ts android|ios <log-out>`.
 * Android: (re)builds the debug APK with the fake reader, starts Metro with
 * EXPO_PUBLIC_CARD_SURFACES=1, installs and launches on the running emulator,
 * captures `adb logcat --pid` to <log-out>, types the fixture values when each
 * CARD_STEP marker appears, and finishes when CARD_SURFACES_DONE arrives. The
 * leak checker runs separately on the captured file.
 * iOS: same flow on the booted simulator where automation is possible; typing
 * uses `idb ui text` when fb-idb is installed — otherwise the run proceeds
 * through the non-typing steps only.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACCESS_CODE,
  DECOY,
  SESSION_APPROVAL_CODE,
  SHORT_ID_TYPED,
} from "../probes/card-surfaces-fixture.ts";

const platform = process.argv[2];
const outFile = resolve(process.argv[3] ?? "card-surfaces.log");
const harness = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = resolve(harness, "../..");
const adb = `${process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`;

const sh = (
  cmd: string,
  args: string[],
  options: { timeout?: number; cwd?: string } = {},
): string => {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeout ?? 60_000,
    cwd: options.cwd,
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
};

const log = (line: string): void => {
  console.log(`[driver] ${line}`);
};

// Watch the capture file for a marker; the process-level tail keeps writing.
const waitFor = (marker: string, timeoutMs: number): void => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(outFile) && readFileSync(outFile, "utf8").includes(marker)) {
      log(`saw ${marker}`);
      return;
    }
    spawnSync("sleep", ["0.4"]);
  }
  throw new Error(`timed out waiting for ${marker}`);
};

const typeText = (text: string): void => {
  sh(adb, ["shell", "input", "text", text]);
  sh(adb, ["shell", "input", "keyevent", "66"]);
  log(`typed ${text.length} chars + enter`);
};

const startMetro = (): ReturnType<typeof spawn> => {
  const metro = spawn(
    "bunx",
    ["expo", "start", "--dev-client", "--port", "8081"],
    {
      cwd: harness,
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
        EXPO_PUBLIC_CARD_SURFACES: "1",
        CI: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  metro.stdout?.on("data", () => {});
  metro.stderr?.on("data", () => {});
  return metro;
};

const waitMetro = (): void => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const probe = spawnSync("curl", ["-sf", "http://localhost:8081/status"], {
      encoding: "utf8",
    });
    if (probe.status === 0) {
      log("metro up");
      return;
    }
    spawnSync("sleep", ["1"]);
  }
  throw new Error("metro did not come up");
};

const android = (): void => {
  log("regenerating probe bundles");
  sh(`${process.env.HOME}/.bun/bin/bun`, ["run", "harness:bundles"], { cwd: root });
  log("building debug APK");
  sh("./gradlew", [":app:assembleDebug"], {
    timeout: 600_000,
    cwd: resolve(harness, "android"),
  });
  log("starting metro");
  const metro = startMetro();
  const logcat = { proc: undefined as ReturnType<typeof spawn> | undefined };
  try {
    waitMetro();
    sh(adb, ["reverse", "tcp:8081", "tcp:8081"]);
    sh(adb, [
      "install",
      "-r",
      resolve(harness, "android/app/build/outputs/apk/debug/app-debug.apk"),
    ]);
    sh(adb, ["logcat", "-c"]);
    sh(adb, ["shell", "am", "start", "-n", "org.qntx.wallet.harness/.MainActivity"]);
    // The process takes a moment to appear after am start returns.
    let pid = "";
    for (let attempt = 0; attempt < 20 && pid === ""; attempt += 1) {
      pid = sh(adb, ["shell", "pidof", "org.qntx.wallet.harness"]).trim();
      if (pid === "") {
        spawnSync("sleep", ["0.5"]);
      }
    }
    if (pid === "") {
      throw new Error("app did not start");
    }
    log(`app pid ${pid}; capturing logcat to ${outFile}`);
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, "");
    logcat.proc = spawn(adb, ["logcat", "--pid", pid], { stdio: "pipe" });
    logcat.proc.stdout?.on("data", (chunk: Buffer) => appendFileSync(outFile, chunk));

    // Cold Metro bundling of the whole graph can take minutes.
    waitFor("CARD_STEP type-decoy", 300_000);
    typeText(DECOY);
    waitFor("CARD_STEP type-code", 60_000);
    // The field arms on the kernel's request; let the keyboard settle.
    spawnSync("sleep", ["1.5"]);
    typeText(ACCESS_CODE);
    waitFor("CARD_STEP type-short-id", 60_000);
    spawnSync("sleep", ["1.5"]);
    typeText(SHORT_ID_TYPED);
    waitFor("CARD_STEP type-approval", 60_000);
    spawnSync("sleep", ["1.5"]);
    typeText(SESSION_APPROVAL_CODE);
    waitFor("CARD_SURFACES_DONE", 240_000);
    log("done — run card-leak-check.ts on the capture");
  } finally {
    logcat.proc?.kill();
    metro.kill();
  }
};

const ios = (): void => {
  const udid = "booted";
  sh("xcrun", ["simctl", "terminate", udid, "org.qntx.wallet.harness.ios"]);
  const appPath = resolve(
    harness,
    "ios/build/Build/Products/Debug-iphonesimulator/V1Harness.app",
  );
  sh("xcrun", ["simctl", "install", udid, appPath]);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, "");
  const stream = spawn(
    "xcrun",
    [
      "simctl",
      "spawn",
      udid,
      "log",
      "stream",
      "--level",
      "debug",
      "--predicate",
      'process == "V1Harness"',
    ],
    { stdio: "pipe" },
  );
  stream.stdout?.on("data", (chunk: Buffer) => appendFileSync(outFile, chunk));
  try {
    const idb = spawnSync("which", ["idb"], { encoding: "utf8" });
    const typing = idb.status === 0;
    if (!typing) {
      log("fb-idb not installed — typing steps cannot be automated");
    }
    sh("xcrun", ["simctl", "launch", udid, "org.qntx.wallet.harness.ios"]);
    // Cold Metro bundling of the whole graph can take minutes.
    waitFor("CARD_STEP type-decoy", 300_000);
    if (typing) {
      // idb ui key takes a HID usage id: 40 is Return.
      spawnSync("idb", ["ui", "text", DECOY]);
      spawnSync("idb", ["ui", "key", "40"]);
      waitFor("CARD_STEP type-code", 60_000);
      spawnSync("sleep", ["1.5"]);
      spawnSync("idb", ["ui", "text", ACCESS_CODE]);
      spawnSync("idb", ["ui", "key", "40"]);
      waitFor("CARD_STEP type-short-id", 60_000);
      spawnSync("sleep", ["1.5"]);
      spawnSync("idb", ["ui", "text", SHORT_ID_TYPED]);
      spawnSync("idb", ["ui", "key", "40"]);
      waitFor("CARD_STEP type-approval", 60_000);
      spawnSync("sleep", ["1.5"]);
      spawnSync("idb", ["ui", "text", SESSION_APPROVAL_CODE]);
      spawnSync("idb", ["ui", "key", "40"]);
      waitFor("CARD_SURFACES_DONE", 240_000);
    } else {
      // Without typing the run stalls at the first input step; capture what
      // the early steps produced and stop.
      spawnSync("sleep", ["10"]);
      log("stopped at the first typing step");
    }
    log("done — run card-leak-check.ts on the capture");
  } finally {
    stream.kill();
  }
};

// The iOS app also needs EXPO_PUBLIC_CARD_SURFACES=1 baked into its bundle:
// run the same Metro, the simulator dev client connects to it.
if (platform === "android") {
  const env = { ...process.env };
  process.env.JAVA_HOME =
    env.JAVA_HOME ?? `${process.env.HOME}/.jdks/jdk-17.0.21.1+2/Contents/Home`;
  process.env.ANDROID_HOME =
    env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`;
  android();
} else if (platform === "ios") {
  const metro = startMetro();
  try {
    waitMetro();
    ios();
  } finally {
    metro.kill();
  }
} else {
  console.error("usage: bun scripts/card-surfaces-run.ts android|ios <log-out>");
  process.exit(2);
}
