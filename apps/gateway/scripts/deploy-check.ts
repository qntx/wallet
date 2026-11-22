import { spawnSync } from "node:child_process";
/* oxlint-disable unicorn/no-process-exit -- a script: process exit is the result channel */
/**
 * Pre-deploy checks for .github/workflows/gateway.yml:
 *
 * Bun scripts/deploy-check.ts secrets <staging|production> bun scripts/deploy-check.ts
 * rollback-plan <staging|production> <commit-sha>
 *
 * `secrets` compares the Worker's remote secret names against the env's `secrets.required` rows in
 * wrangler.jsonc and exits 1 with the exact remediation command when any is missing — a Worker that
 * does not exist yet means the first deploy is the manual operator step (README "Operator
 * runbook").
 *
 * `rollback-plan` decides, before a deploy, whether a later failed smoke can roll back
 * automatically: Cloudflare refuses a rollback when the Durable Object class lifecycle changed
 * between versions (https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
 * The active deployment's `workers/message` annotation carries `deploy <sha>` (set by the deploy
 * step); that commit's `migrations` in wrangler.jsonc must equal the deploying commit's. The
 * verdict is appended to $GITHUB_OUTPUT as `rollback_version` and `rollback_reason`.
 */
import { appendFileSync, readFileSync } from "node:fs";

import { parseJsonc } from "./jsonc.ts";

declare const process: {
  readonly argv: ReadonlyArray<string>;
  readonly env: {
    readonly GH_TOKEN?: string;
    readonly GITHUB_OUTPUT?: string;
    readonly GITHUB_REPOSITORY?: string;
  };
  exit: (code: number) => never;
};

// ---------------------------------------------------------------- pure logic

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/* Member reads on `Record<string, unknown>`: a literal `o["k"]` trips dot-notation and `o.k`
   trips `noPropertyAccessFromIndexSignature`; a variable key satisfies both. */
const prop = (o: Record<string, unknown>, key: string): unknown => o[key];

const strProp = (o: Record<string, unknown>, key: string): string | undefined => {
  const v = prop(o, key);
  return typeof v === "string" ? v : undefined;
};

const objProp = (o: Record<string, unknown>, key: string): Record<string, unknown> | undefined => {
  const v = prop(o, key);
  return isObj(v) ? v : undefined;
};

const arrProp = (o: Record<string, unknown>, key: string): ReadonlyArray<unknown> => {
  const v = prop(o, key);
  return Array.isArray(v) ? (v as ReadonlyArray<unknown>) : [];
};

const numProp = (o: Record<string, unknown>, key: string): number | undefined => {
  const v = prop(o, key);
  return typeof v === "number" ? v : undefined;
};

/**
 * The `wrangler secret list --format json` rows → names. Throws when the output is not the API
 * shape.
 */
export function parseSecretNames(output: string): string[] {
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows)) {
    throw new TypeError(`unexpected secret list output: ${output.slice(0, 120)}`);
  }
  const names: string[] = [];
  for (const row of rows) {
    if (!isObj(row)) {
      throw new Error(`unexpected secret list output: ${output.slice(0, 120)}`);
    }
    const name = strProp(row, "name");
    if (name === undefined) {
      throw new Error(`unexpected secret list output: ${output.slice(0, 120)}`);
    }
    names.push(name);
  }
  return names;
}

/**
 * `wrangler secret list` surfaces an absent Worker as `Worker "<name>" (env: <env>) not found.`
 * (the API's 10007/10090 become that UserError); other transports print the bare code.
 */
export function workerNotFound(stderr: string): boolean {
  return (
    /Worker "[^"]+"(\s*\(env:[^)]*\))?\s*not found/i.test(stderr) || /\b100(?:07|90)\b/.test(stderr)
  );
}

/** Required names that the remote list does not contain. */
export function missingRequired(
  required: ReadonlyArray<string>,
  present: ReadonlyArray<string>,
): string[] {
  const have = new Set(present);
  return required.filter((name) => !have.has(name));
}

export type Deployment = {
  readonly id: string;
  readonly created_on: string;
  readonly message: string | undefined;
  readonly versionId: string;
};

/**
 * `wrangler deployments list --json` rows (verified against wrangler 4.160.0, cli.js:356306 — the
 * handler sorts ascending by `created_on` before printing, so the LAST row serves traffic now).
 * Each row: `{id, created_on, author_email, source, annotations?, versions: [{version_id,
 * percentage}]}`; `wrangler deploy --message` lands in `annotations["workers/message"]` (the
 * deployment POST at cli.js:170971 sets it, same as the version annotation at cli.js:183553).
 */
export function parseDeployments(output: string): Deployment[] {
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows)) {
    throw new TypeError(`unexpected deployments output: ${output.slice(0, 120)}`);
  }
  return rows.map((row) => {
    if (!isObj(row)) {
      throw new Error(`unexpected deployment row: ${JSON.stringify(row).slice(0, 120)}`);
    }
    const id = strProp(row, "id");
    const created = strProp(row, "created_on");
    if (id === undefined || created === undefined) {
      throw new Error(`unexpected deployment row: ${JSON.stringify(row).slice(0, 120)}`);
    }
    const annotations = objProp(row, "annotations") ?? {};
    const message = strProp(annotations, "workers/message");
    const versions = arrProp(row, "versions").filter(isObj);
    let serving: { id: string; percentage: number } | undefined;
    for (const v of versions) {
      const vid = strProp(v, "version_id");
      const pct = numProp(v, "percentage") ?? 0;
      if (vid !== undefined && (serving === undefined || pct >= serving.percentage)) {
        serving = { id: vid, percentage: pct };
      }
    }
    if (serving === undefined) {
      throw new Error(`deployment ${id} has no version rows`);
    }
    return { id, created_on: created, message, versionId: serving.id };
  });
}

/** The deployment serving traffic now: the newest `created_on` (the list arrives ascending). */
export function activeDeployment(deployments: ReadonlyArray<Deployment>): Deployment | undefined {
  let latest: Deployment | undefined;
  for (const d of deployments) {
    if (latest === undefined || d.created_on >= latest.created_on) {
      latest = d;
    }
  }
  return latest;
}

/** The `deploy <40-hex sha>` the workflow writes as `--message`. */
export function commitFromMessage(message: string | undefined): string | undefined {
  const match = /^deploy ([0-9a-f]{40})$/.exec(message ?? "");
  return match?.[1];
}

/** `env.<env>.secrets.required` from a parsed wrangler.jsonc document. */
export function requiredSecrets(config: unknown, env: string): string[] {
  if (!isObj(config)) {
    return [];
  }
  const envs = objProp(config, "env") ?? {};
  const entry = objProp(envs, env) ?? {};
  const secrets = objProp(entry, "secrets") ?? {};
  return arrProp(secrets, "required").filter((n): n is string => typeof n === "string");
}

/** The top-level `migrations` rows — the DO class lifecycle record a rollback compares. */
export function migrationsOf(config: unknown): unknown {
  return isObj(config) ? prop(config, "migrations") : undefined;
}

export type RollbackPlan = {
  /** The version id `wrangler rollback` would target; "" when no safe rollback exists. */
  readonly rollbackVersion: string;
  /** One line, for the workflow's `::error::` when `rollbackVersion` is "". */
  readonly reason: string;
};

/** The plan decision: deploy only when the DO lifecycle matches and a commit is identifiable. */
export function planRollback(input: {
  readonly deployment: Deployment | undefined;
  readonly deployedCommit: string | undefined;
  readonly newCommit: string;
  readonly oldMigrations: unknown;
  readonly newMigrations: unknown;
}): RollbackPlan {
  if (input.deployment === undefined) {
    return { rollbackVersion: "", reason: "no previous deployment exists (the first deploy)" };
  }
  if (input.deployedCommit === undefined) {
    return {
      rollbackVersion: "",
      reason: `deployment ${input.deployment.id} has no 'deploy <sha>' message annotation`,
    };
  }
  if (JSON.stringify(input.oldMigrations) !== JSON.stringify(input.newMigrations)) {
    return {
      rollbackVersion: "",
      reason:
        `durable-object migrations differ between ${input.deployedCommit.slice(0, 10)} and ` +
        `${input.newCommit.slice(0, 10)} — Cloudflare refuses a rollback across a class lifecycle ` +
        "change",
    };
  }
  return { rollbackVersion: input.deployment.versionId, reason: "ok" };
}

// ------------------------------------------------------------------- IO layer

const GATEWAY = new URL("../", import.meta.url).pathname;
const WRANGLER = new URL("../node_modules/.bin/wrangler", import.meta.url).pathname;

type RunResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

const run = (cmd: ReadonlyArray<string>, cwd = GATEWAY): RunResult => {
  const out = spawnSync(cmd[0] ?? "", cmd.slice(1), { cwd, encoding: "utf8" });
  return {
    code: out.status ?? 1,
    stdout: out.stdout ?? "",
    stderr: `${out.stderr ?? ""}${out.error === undefined ? "" : String(out.error)}`,
  };
};

const wranglerConfig = (): unknown => parseJsonc(readFileSync(`${GATEWAY}wrangler.jsonc`, "utf8"));

/** `git show <sha>:apps/gateway/wrangler.jsonc` after a depth-1 fetch of that commit. */
const migrationsAt = (
  sha: string,
): { ok: true; value: unknown } | { ok: false; reason: string } => {
  const root = run(["git", "rev-parse", "--show-toplevel"]);
  if (root.code !== 0) {
    return { ok: false, reason: "not inside a git work tree" };
  }
  const toplevel = root.stdout.trim();
  const token = process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const remote =
    token !== undefined && repo !== undefined
      ? `https://x-access-token:${token}@github.com/${repo}.git`
      : "origin";
  const fetched = run(["git", "fetch", "--depth", "1", remote, sha], toplevel);
  if (fetched.code !== 0) {
    return {
      ok: false,
      reason: `git fetch of ${sha.slice(0, 10)} failed: ${fetched.stderr.trim().slice(0, 200)}`,
    };
  }
  const shown = run(["git", "show", `${sha}:apps/gateway/wrangler.jsonc`], toplevel);
  if (shown.code !== 0) {
    return { ok: false, reason: `git show of ${sha.slice(0, 10)}'s wrangler.jsonc failed` };
  }
  return { ok: true, value: migrationsOf(parseJsonc(shown.stdout)) };
};

const emitOutput = (plan: RollbackPlan): void => {
  const lines = `rollback_version=${plan.rollbackVersion}\nrollback_reason=${plan.reason}\n`;
  const target = process.env.GITHUB_OUTPUT;
  if (target !== undefined) {
    appendFileSync(target, lines);
  }
  console.log(lines.trimEnd());
};

const secrets = (env: string): number => {
  const result = run([WRANGLER, "secret", "list", "--env", env, "--format", "json"]);
  if (result.code !== 0) {
    if (workerNotFound(result.stderr)) {
      console.log(
        `::error::the ${env} Worker does not exist yet — the first deploy is the manual ` +
          `operator step (apps/gateway/README.md "Operator runbook"): ` +
          `bunx wrangler deploy --env ${env} --secrets-file <file>`,
      );
    } else {
      console.log(`::error::wrangler secret list failed: ${result.stderr.trim().slice(0, 300)}`);
    }
    return 1;
  }
  const required = requiredSecrets(wranglerConfig(), env);
  const missing = missingRequired(required, parseSecretNames(result.stdout));
  if (missing.length > 0) {
    console.log(
      `::error::missing required secrets:\n${missing
        .map((name) => `bunx wrangler secret put ${name} --env ${env}`)
        .join("\n")}`,
    );
    return 1;
  }
  console.log(`all ${String(required.length)} required secrets present on ${env}`);
  return 0;
};

const rollbackPlan = (env: string, commit: string): number => {
  const result = run([WRANGLER, "deployments", "list", "--env", env, "--json"]);
  if (result.code !== 0) {
    // A missing Worker's deployments list fails the same way a missing Worker does — treat it
    // as "no previous deployment" so the first deploy's plan still records a reason.
    const plan = workerNotFound(result.stderr)
      ? planRollback({
          deployment: undefined,
          deployedCommit: undefined,
          newCommit: commit,
          oldMigrations: undefined,
          newMigrations: undefined,
        })
      : {
          rollbackVersion: "",
          reason: `deployments list failed: ${result.stderr.trim().slice(0, 200)}`,
        };
    emitOutput(plan);
    return 0;
  }
  const active = activeDeployment(parseDeployments(result.stdout));
  const deployedCommit = commitFromMessage(active?.message);
  let oldMigrations: unknown;
  let extraReason: string | undefined;
  if (deployedCommit === undefined) {
    oldMigrations = undefined;
  } else {
    const found = migrationsAt(deployedCommit);
    if (found.ok) {
      oldMigrations = found.value;
    } else {
      extraReason = `cannot compare migrations — ${found.reason}`;
    }
  }
  const plan =
    extraReason === undefined
      ? planRollback({
          deployment: active,
          deployedCommit,
          newCommit: commit,
          oldMigrations,
          newMigrations: migrationsOf(wranglerConfig()),
        })
      : { rollbackVersion: "", reason: extraReason };
  emitOutput(plan);
  if (plan.rollbackVersion === "") {
    console.log(`::warning::no automatic rollback target for ${env}: ${plan.reason}`);
  }
  return 0;
};

// `import.meta.main` is set by bun only for the entry file — vitest imports the module for tests.
const meta: unknown = import.meta;
if (isObj(meta) && prop(meta, "main") === true) {
  const [command, env, commit] = process.argv.slice(2);
  if (
    (env !== "staging" && env !== "production") ||
    (command !== "secrets" && command !== "rollback-plan")
  ) {
    console.error("usage: deploy-check.ts secrets|rollback-plan <staging|production> [<commit>]");
    process.exit(2);
  }
  process.exit(command === "secrets" ? secrets(env) : rollbackPlan(env, commit ?? ""));
}
