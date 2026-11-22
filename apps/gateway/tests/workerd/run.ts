/* oxlint-disable unicorn/no-process-exit -- a script: process exit is the result channel */
/**
 * Workerd harness runner: starts `wrangler dev` for the isolates a scenario needs, waits for
 * readiness, runs the drive scenario, and always stops the wrangler processes. Usage:
 *
 * Bun tests/workerd/run.ts # the default suite bun tests/workerd/run.ts <scenario> # one of
 * smoke|steady|s1|s2|s4|s5|s6|s7|storm
 *
 * `smoke` runs the real deploy smoke plan (scripts/smoke-plan.ts runSmoke, env production) against
 * worker A — the entry's stub upstream answers the smoke calls.
 *
 * Fixed ports: A on 8801 owns the Durable Objects; B on 8802 reaches them through the local dev
 * registry (`script_name` in wrangler.peer.json), which also means B alone exercises the
 * object-down path. The exit code is the aggregate drive result.
 */
import { runSmoke } from "../../scripts/smoke-plan.ts";

declare const process: {
  readonly argv: ReadonlyArray<string>;
  readonly env: { readonly TMPDIR?: string };
  exit: (code: number) => never;
};

declare const Bun: {
  readonly spawn: (
    cmd: ReadonlyArray<string>,
    options: { readonly cwd?: string; readonly stdout?: string; readonly stderr?: string },
  ) => {
    readonly exited: Promise<number>;
    kill: (signal?: string | number) => void;
  };
};

const HERE = new URL(".", import.meta.url).pathname;
const WRANGLER = new URL("../../node_modules/.bin/wrangler", import.meta.url).pathname;

const PORT_A = 8801;
const PORT_B = 8802;

type Worker = { readonly config: string; readonly port: number };

/** A owns the objects; B shares them through `script_name`. */
const WORKER_A: Worker = { config: "wrangler.json", port: PORT_A };
const WORKER_B: Worker = { config: "wrangler.peer.json", port: PORT_B };

const GROUPS: Record<string, { readonly workers: ReadonlyArray<Worker>; readonly scale: string }> =
  {
    smoke: { workers: [WORKER_A], scale: "production" },
    steady: { workers: [WORKER_A], scale: "production" },
    s1: { workers: [WORKER_A], scale: "production" },
    s5: { workers: [WORKER_A], scale: "production" },
    s6: { workers: [WORKER_A], scale: "production" },
    s7: { workers: [WORKER_A], scale: "production" },
    s2: { workers: [WORKER_A, WORKER_B], scale: "small" },
    storm: { workers: [WORKER_A, WORKER_B], scale: "small" },
    // B alone: its `script_name` binding cannot reach A's objects — the outage scenario.
    s4: { workers: [WORKER_B], scale: "small" },
  };

const DEFAULT_SUITE = ["smoke", "steady", "s1", "s7", "s6", "s5", "s2", "storm", "s4"];

type Running = { readonly exited: Promise<number>; kill: () => void };

const running: Running[] = [];
let runningKey = "";

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
};

const stopAll = async (): Promise<void> => {
  for (const proc of running) {
    proc.kill();
  }
  await Promise.allSettled(running.map(async (proc) => proc.exited));
  running.length = 0;
  runningKey = "";
};

/** Starts `wrangler dev` for `worker` and polls its stats route until it answers. */
const start = async (worker: Worker, scale: string, persistTo: string): Promise<void> => {
  const proc = Bun.spawn(
    [
      WRANGLER,
      "dev",
      "-c",
      worker.config,
      "--port",
      String(worker.port),
      "--persist-to",
      persistTo,
      "--var",
      `SCALE:${scale}`,
    ],
    { cwd: HERE, stdout: "inherit", stderr: "inherit" },
  );
  running.push(proc);
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a readiness poll waits between tries
      const res = await fetch(`http://localhost:${String(worker.port)}/__stats`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
      await res.text();
      if (res.ok) {
        return;
      }
    } catch {
      // workerd not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`worker ${worker.config} on :${String(worker.port)} never became ready`);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- poll interval
    await sleep(300);
  }
};

/** The deploy smoke plan against the real worker — 0 when every check passes. */
const smokeAgainst = async (base: string): Promise<number> => {
  // Local workerd does not set cf-connecting-ip the way the edge does — the harness entry maps
  // x-test-ip into it, and the gateway requires a client address.
  const { passed, failures } = await runSmoke({
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("x-test-ip", "203.0.113.50");
      return globalThis.fetch(input, { ...init, headers });
    },
    baseUrl: base,
    env: "production",
  });
  for (const name of passed) {
    console.log(`smoke: pass ${name}`);
  }
  for (const failure of failures) {
    console.log(`smoke: FAIL ${failure}`);
  }
  return failures.length === 0 ? 0 : 1;
};

const main = async (): Promise<void> => {
  const [requested] = process.argv.slice(2);
  const scenarios = requested === undefined ? DEFAULT_SUITE : [requested];
  const root = `${process.env.TMPDIR ?? "/tmp"}/gateway-harness-${String(Date.now())}`;
  let failures = 0;
  try {
    for (const scenario of scenarios) {
      const group = GROUPS[scenario];
      if (group === undefined) {
        console.log(`unknown scenario ${scenario}`);
        process.exit(2);
      }
      const key = `${group.scale}:${group.workers.map((worker) => worker.port).join(",")}`;
      if (runningKey !== key) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- ports must be free before the restart
        await stopAll();
        for (const worker of group.workers) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- sequential starts isolate port races
          await start(worker, group.scale, `${root}/${String(worker.port)}`);
        }
        runningKey = key;
      }
      const urls = group.workers.map((worker) => `http://localhost:${String(worker.port)}`);
      console.log(`run: ${scenario} → ${urls.join(" ")}`);
      const runScenario = async (): Promise<number> =>
        scenario === "smoke"
          ? smokeAgainst(urls[0] ?? "")
          : Bun.spawn(["bun", "drive.ts", scenario, ...urls], {
              cwd: HERE,
              stdout: "inherit",
              stderr: "inherit",
            }).exited;
      // oxlint-disable-next-line eslint/no-await-in-loop -- scenarios run one at a time
      const code = await runScenario();
      if (code !== 0) {
        failures += 1;
        console.log(`run: ${scenario} exited ${String(code)}`);
      }
    }
  } finally {
    await stopAll();
  }
  console.log(
    failures === 0 ? "run: all scenarios passed" : `run: ${String(failures)} scenario(s) failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
};

await main();
