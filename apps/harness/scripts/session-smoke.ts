/**
 * Session-factor smoke driver. Launches the harness one phase at a time through
 * a `session/<phase>` URL, answers system prompts when the app says
 * `smoke-waiting-*`, toggles the Android lock screen between phases and writes
 * one log per run to apps/harness/results/.
 *
 *   bun scripts/session-smoke.ts ios <udid> <scenario...>
 *   bun scripts/session-smoke.ts android <serial> <scenario...>
 *
 * Scenarios: a (a1,a2,a3) | auto | b (b1,b2,b3; Android toggles the lock
 * screen) | or a bare phase name (a1..b3, silent, phys) to run once.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = process.env.HOME!;
const ADB = `${HOME}/Library/Android/sdk/platform-tools/adb`;
const IOS_BUNDLE = "org.qntx.wallet.harness.ios";
const ANDROID_PKG = "org.qntx.wallet.harness";
const ANDROID_ACT = `${ANDROID_PKG}/.MainActivity`;
const PIN = "1234";
const RESULTS = join(dirname(fileURLToPath(import.meta.url)), "..", "results");

const [, , platform, serial, ...scenarios] = process.argv;
if (
  (platform !== "ios" && platform !== "android") ||
  serial === undefined ||
  scenarios.length === 0
) {
  console.error("usage: session-smoke.ts <ios|android> <udid|serial> <scenario...>");
  process.exit(2);
}
const ios = platform === "ios";

const run = (args: string[]): string => {
  const out = spawnSync(args[0]!, args.slice(1), { encoding: "utf8" });
  return `${out.stdout ?? ""}${out.stderr ?? ""}`;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const terminate = (): void => {
  run(
    ios
      ? ["xcrun", "simctl", "terminate", serial, IOS_BUNDLE]
      : [ADB, "-s", serial, "shell", "am", "force-stop", ANDROID_PKG],
  );
};

const launch = (phaseName: string): void => {
  if (ios) {
    // A cold `simctl openurl` only raises a SpringBoard "open in app" alert on
    // iOS 27 — the app never starts. Drop the phase into the container
    // instead; the app reads and deletes it on startup.
    writeFileSync(containerPath("session-phase"), phaseName);
    run(["xcrun", "simctl", "launch", serial, IOS_BUNDLE]);
  } else {
    // getInitialURL requires ACTION_VIEW; explicit -n skips intent-filter resolution.
    run([
      ADB, "-s", serial, "shell", "am", "start", "-a", "android.intent.action.VIEW",
      "-n", ANDROID_ACT, "-d", `harness://session/${phaseName}`,
    ]);
  }
};

const background = (): void => {
  if (ios) {
    // Foregrounding another app puts the harness in the background.
    run(["xcrun", "simctl", "launch", serial, "com.apple.Preferences"]);
  } else {
    run([ADB, "-s", serial, "shell", "input", "keyevent", "3"]);
  }
};

const foreground = (): void => {
  if (ios) {
    // `simctl launch` on the running app returns the same pid and raises it.
    run(["xcrun", "simctl", "launch", serial, IOS_BUNDLE]);
  } else {
    // `am start -n` does not resume the RN lifecycle; the launcher does.
    run([ADB, "-s", serial, "shell", "monkey", "-p", ANDROID_PKG, "1"]);
  }
};

const approve = (): void => {
  if (ios) {
    run([
      "xcrun", "simctl", "spawn", serial, "notifyutil", "-p",
      "com.apple.BiometricKit_Sim.pearl.match",
    ]);
  } else {
    run([ADB, "-s", serial, "shell", "input", "text", PIN]);
    run([ADB, "-s", serial, "shell", "input", "keyevent", "66"]);
  }
};

const iosAppPath = (): string => {
  const derived = join(HOME, "Library/Developer/Xcode/DerivedData");
  const hit = readdirSync(derived)
    .filter((dir) => dir.startsWith("V1Harness-"))
    .map((dir) =>
      join(derived, dir, "Build/Products/Release-iphonesimulator/V1Harness.app"))
    .find((path) => existsSync(path));
  if (hit === undefined) {
    throw new Error("no built V1Harness.app under DerivedData");
  }
  return hit;
};

const clean = (): void => {
  if (ios) {
    run(["xcrun", "simctl", "uninstall", serial, IOS_BUNDLE]);
    run(["xcrun", "simctl", "install", serial, iosAppPath()]);
  } else {
    run([ADB, "-s", serial, "shell", "pm", "clear", ANDROID_PKG]);
  }
};

const lockScreen = (on: boolean): void => {
  if (ios) {
    return;
  }
  if (on) {
    run([ADB, "-s", serial, "shell", "locksettings", "set-pin", PIN]);
  } else {
    run([ADB, "-s", serial, "shell", "locksettings", "clear", "--old", PIN]);
    run([ADB, "-s", serial, "shell", "locksettings", "set-disabled", "true"]);
  }
};

/** Keeps the display awake and the keyguard dismissed — Android keys marked
 * `setUnlockedDeviceRequired` refuse to init while the device is locked, and
 * the API-37 image dozes ~10s after the last input regardless of
 * `screen_off_timeout`, so a phase also pokes KEYCODE_WAKEUP periodically. */
const deviceReady = (): void => {
  if (ios) {
    return;
  }
  run([ADB, "-s", serial, "shell", "settings", "put", "system", "screen_off_timeout", "2147483647"]);
  // Fake AC power so stay-on-while-plugged holds — the API-37 image dozes ~10s
  // after the last input regardless of screen_off_timeout.
  run([ADB, "-s", serial, "shell", "dumpsys", "battery", "set", "ac", "1"]);
  run([ADB, "-s", serial, "shell", "svc", "power", "stayon", "true"]);
  const asleep = run([ADB, "-s", serial, "shell", "dumpsys", "power"]).includes("mWakefulness=Asleep");
  const locked = run([ADB, "-s", serial, "shell", "dumpsys", "trust"]).includes("deviceLocked=1");
  if (asleep) {
    run([ADB, "-s", serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
  }
  if (locked) {
    run([ADB, "-s", serial, "shell", "input", "keyevent", "82"]);
    run([ADB, "-s", serial, "shell", "input", "text", PIN]);
    run([ADB, "-s", serial, "shell", "input", "keyevent", "66"]);
  }
};

const keepAwake = (): (() => void) => {
  if (ios) {
    return () => undefined;
  }
  const timer = setInterval(
    () => run([ADB, "-s", serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP"]),
    7000,
  );
  return () => clearInterval(timer);
};

const enrollFaceId = (): void => {
  run([
    "xcrun", "simctl", "spawn", serial, "notifyutil", "-s",
    "com.apple.BiometricKit.enrollmentChanged", "1",
  ]);
  run([
    "xcrun", "simctl", "spawn", serial, "notifyutil", "-p",
    "com.apple.BiometricKit.enrollmentChanged",
  ]);
};

type Captured = { probe: string; ok: boolean; detail: string };
type LogHandle = { kill: () => void };

const containerPath = (name: string): string =>
  join(
    run(["xcrun", "simctl", "get_app_container", serial, IOS_BUNDLE, "data"]).trim(),
    "Documents",
    name,
  );

/** iOS: the app appends `probe ok detail` lines to Documents/session-smoke.log
 * inside its data container (stderr is unreachable for openurl launches);
 * tails it with the file offset kept across polls. */
const tailContainerLog = (logFile: string, onResult: (r: Captured) => void): LogHandle => {
  const logPath = containerPath("session-smoke.log");
  let offset = 0;
  const timer = setInterval(() => {
    let text: string;
    try {
      text = readFileSync(logPath, "utf8");
    } catch {
      return;
    }
    if (text.length <= offset) {
      return;
    }
    const fresh = text.slice(offset);
    offset = text.length;
    for (const line of fresh.split("\n")) {
      appendFileSync(logFile, `${line}\n`);
      const m = /^(\S+) ([01]) ?(.*)$/.exec(line);
      if (m !== null) {
        onResult({ probe: `smoke-${m[1]}`, ok: m[2] === "1", detail: m[3] ?? "" });
      }
    }
  }, 300);
  return { kill: () => clearInterval(timer) };
};

/** Streams `V1_RESULT` records (reassembling Android V1_CONT chunks) to onResult + the log file. */
const startLog = (logFile: string, onResult: (r: Captured) => void): LogHandle => {
  if (ios) {
    return tailContainerLog(logFile, onResult);
  }
  // -T limits to entries after now — `logcat -c` alone replays stale buffer
  // lines into a freshly spawned reader and corrupts phase attribution.
  // Inner quotes keep the space in `+%m-%d %H:%M:%S` one argument on the
  // remote shell — unquoted adb args are re-split and epoch `-T` does
  // not actually filter on this logcat.
  const proc = spawn(ADB, [
    "-s", serial, "logcat", "-T",
    run([ADB, "-s", serial, "shell", 'date "+%m-%d %H:%M:%S.000"']).trim(),
    "-s", "V1Probe:V",
  ]);
  let pending = "";
  let carry = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const raw = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      appendFileSync(logFile, `${raw}\n`);
      const marker = raw.indexOf("V1_RESULT");
      const cont = raw.indexOf("V1_CONT");
      if (marker >= 0) {
        carry = raw.slice(marker + "V1_RESULT".length).trimStart();
      } else if (cont >= 0) {
        carry += raw.slice(cont + "V1_CONT".length).trimStart();
      }
      if (carry.startsWith("{") && carry.endsWith("}")) {
        try {
          const parsed = JSON.parse(carry) as {
            probe: string;
            ok: boolean;
            result?: string;
            error?: string;
          };
          if (parsed.probe.startsWith("smoke-")) {
            onResult({
              probe: parsed.probe,
              ok: parsed.ok,
              detail:
                typeof parsed.result === "string"
                  ? parsed.result
                  : JSON.stringify(parsed.result ?? parsed.error ?? ""),
            });
          }
        } catch {
          // unparseable fragment — keep going
        }
        carry = "";
      }
    }
  });
  return proc;
};

/** Runs one phase; resolves false on timeout or any failed step. */
const phase = async (
  name: string,
  logFile: string,
  opts?: { backgroundAfter?: string },
): Promise<boolean> => {
  deviceReady();
  terminate();
  if (ios) {
    // Fresh log per phase — the tailer would otherwise replay a prior
    // phase's smoke-done and resolve instantly.
    run(["rm", "-f", containerPath("session-smoke.log")]);
  }
  await sleep(1500);
  const stopAwake = keepAwake();
  const done = new Promise<boolean>((resolve) => {
    const results: Captured[] = [];
    const proc = startLog(logFile, (r) => {
      results.push(r);
      console.log(`  ${r.probe} ${r.ok ? "ok" : "FAIL"} ${r.detail}`);
      if (r.probe.startsWith("smoke-waiting-")) {
        void (async () => {
          for (const delay of [3000, 6000, 10000]) {
            await sleep(delay);
            approve();
          }
        })();
      }
      if (opts?.backgroundAfter !== undefined && r.probe === `smoke-${opts.backgroundAfter}`) {
        void (async () => {
          await sleep(1500);
          background();
          await sleep(5000);
          deviceReady();
          foreground();
        })();
      }
      if (r.probe === "smoke-done") {
        proc.kill();
        resolve(r.ok && results.every((x) => x.ok));
      }
    });
    setTimeout(() => launch(name), 800);
    setTimeout(
      () => {
        proc.kill();
        resolve(false);
      },
      name === "auto" ? 180_000 : 120_000,
    );
  });
  const ok = await done;
  stopAwake();
  console.log(`  phase ${name}: ${ok ? "ok" : "FAILED/timeout"}`);
  return ok;
};

mkdirSync(RESULTS, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const iosVersion = (): string => {
  try {
    const listed = JSON.parse(run(["xcrun", "simctl", "list", "devices", "-j"])) as {
      devices: Record<string, { udid: string }[]>;
    };
    for (const [runtime, devices] of Object.entries(listed.devices)) {
      if (devices.some((d) => d.udid === serial)) {
        return runtime.match(/iOS-(\d+-\d+)/)?.[1]?.replace("-", ".") ?? "?";
      }
    }
  } catch {
    // fall through
  }
  return "?";
};
const osver = ios
  ? iosVersion()
  : run([ADB, "-s", serial, "shell", "getprop", "ro.build.version.sdk"]).trim();
const logFile = join(RESULTS, `session-${platform}-${osver}-${stamp}.log`);
console.log(`log: ${logFile}`);

if (ios) {
  enrollFaceId();
}

const named: Record<string, () => Promise<boolean>> = {
  a: async () => {
    lockScreen(true);
    await sleep(500);
    clean();
    await sleep(1000);
    let ok = await phase("a1", logFile);
    ok = (await phase("a2", logFile)) && ok;
    ok = (await phase("a3", logFile)) && ok;
    return ok;
  },
  auto: async () => phase("auto", logFile, { backgroundAfter: "auto-armed" }),
  b: async () => {
    lockScreen(false);
    await sleep(500);
    clean();
    await sleep(1000);
    let ok = await phase("b1", logFile);
    lockScreen(true);
    await sleep(1500);
    ok = (await phase("b2", logFile)) && ok;
    if (!ios) {
      lockScreen(false);
      await sleep(1500);
      ok = (await phase("b3", logFile)) && ok;
    }
    lockScreen(true);
    return ok;
  },
};

let overall = true;
for (const scenario of scenarios) {
  const runner = named[scenario];
  overall = (runner !== undefined ? await runner() : await phase(scenario, logFile)) && overall;
}
console.log(overall ? "ALL OK" : "FAILURES PRESENT");
process.exit(overall ? 0 : 1);
