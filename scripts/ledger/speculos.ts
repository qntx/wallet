/**
 * Start (default) or stop one speculos container per app in scripts/ledger/apps.json.
 *
 * Each container runs `speculos --model nanosp --display headless` on the app's ELF with the pinned
 * seed and a fixed --deterministic-rng (RNG_SEED is atoi'd by src/environment.c, so any integer
 * works; it makes APDU-side randomness — e.g. BIP-340 nonces — reproducible). The APDU TCP port and
 * the REST API port are published on distinct 127.0.0.1 host ports; the resulting endpoint map is
 * written to .cache/ledger/endpoints.json for tests/speculos/harness.ts.
 *
 * Usage: bun scripts/ledger/speculos.ts [start|stop]
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pins from "./apps.json" with { type: "json" };

const root = fileURLToPath(new URL("../..", import.meta.url));
const cache = resolve(root, ".cache/ledger");
const elfDir = resolve(cache, "elf");
const endpointsPath = resolve(cache, "endpoints.json");

// Host port layout: app index i -> APDU 40000+i, REST API 41000+i.
const APDU_BASE = 40000;
const API_BASE = 41000;
const APDU_CONTAINER_PORT = 9999;
const API_CONTAINER_PORT = 5000;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const containerName = (key: string): string => `qntx-speculos-${key}`;

function capture(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${String(result.status)}`);
  }
  return result.stdout.toString().trim();
}

function docker(...args: string[]): void {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} exited with ${String(result.status)}`);
  }
}

function running(name: string): boolean {
  const result = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", name], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout.toString().trim() === "true";
}

async function waitApi(apiPort: number, name: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      // /events exists on every model; any HTTP response means the API server is up.
      // oxlint-disable-next-line eslint/no-await-in-loop -- polling until the server answers
      await fetch(`http://127.0.0.1:${String(apiPort)}/events?currentscreenonly=true`);
      return;
    } catch {
      if (Date.now() > deadline) {
        const logs = capture("docker", ["logs", "--tail", "50", name]);
        throw new Error(`${name}: API did not come up in 60s\n${logs}`);
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- polling interval
      await sleep(250);
    }
  }
}

async function start(): Promise<void> {
  mkdirSync(cache, { recursive: true });
  const endpoints: Record<string, { apdu: string; api: string }> = {};
  const keys = Object.keys(pins.apps);

  for (const [i, key] of keys.entries()) {
    const elf = resolve(elfDir, `${key}.elf`);
    if (!existsSync(elf)) {
      throw new Error(`${key}: missing ${elf} — run bun scripts/ledger/build-apps.ts first`);
    }
    const name = containerName(key);
    const apduPort = APDU_BASE + i;
    const apiPort = API_BASE + i;
    endpoints[key] = {
      apdu: `127.0.0.1:${String(apduPort)}`,
      api: `http://127.0.0.1:${String(apiPort)}`,
    };
    if (running(name)) {
      console.log(`${key}: ${name} already running`);
      continue;
    }
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    docker(
      "run",
      "-d",
      "--name",
      name,
      "-p",
      `127.0.0.1:${String(apduPort)}:${String(APDU_CONTAINER_PORT)}`,
      "-p",
      `127.0.0.1:${String(apiPort)}:${String(API_CONTAINER_PORT)}`,
      "-v",
      `${elfDir}:/apps:ro`,
      pins.images.speculos,
      "--model",
      pins.model,
      "--display",
      "headless",
      "--seed",
      pins.seed,
      "--deterministic-rng",
      pins.deterministicRng,
      `/apps/${key}.elf`,
    );
  }

  for (const [i, key] of keys.entries()) {
    const endpoint = endpoints[key];
    if (endpoint === undefined) {
      throw new Error(`missing endpoint for ${key}`);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- containers come up one at a time
    await waitApi(API_BASE + i, containerName(key));
    console.log(`${key}: API up on ${endpoint.api}, APDU on ${endpoint.apdu}`);
  }
  writeFileSync(endpointsPath, `${JSON.stringify(endpoints, null, 2)}\n`);
  console.log(`wrote ${endpointsPath}`);
}

function stop(): void {
  for (const key of Object.keys(pins.apps)) {
    const name = containerName(key);
    if (running(name) || spawnSync("docker", ["inspect", name], { stdio: "ignore" }).status === 0) {
      docker("rm", "-f", name);
      console.log(`${key}: removed ${name}`);
    }
  }
}

const mode = process.argv[2] ?? "start";
if (mode === "start") {
  await start();
} else if (mode === "stop") {
  stop();
} else {
  throw new Error(`usage: bun scripts/ledger/speculos.ts [start|stop]`);
}
