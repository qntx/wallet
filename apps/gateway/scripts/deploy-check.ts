import { spawnSync } from "node:child_process";
/* oxlint-disable unicorn/no-process-exit -- a script: process exit is the result channel */
/**
 * Pre-deploy checks for .github/workflows/gateway.yml:
 *
 * Bun scripts/deploy-check.ts environments bun scripts/deploy-check.ts secrets <staging|production>
 * bun scripts/deploy-check.ts token <staging|production> bun scripts/deploy-check.ts rollback-plan
 * <staging|production> <commit-sha>
 *
 * `environments` reads both GitHub environments through `gh api` and requires them to carry the
 * same reviewer gate on the main branch, and reads wrangler.jsonc for state the two Workers would
 * share — staging and production live in one Cloudflare account, so the approval gate and config
 * isolation are the only things separating them.
 *
 * `token` asks Cloudflare's tokens/verify whether the environment's CLOUDFLARE_API_TOKEN is an
 * active token of the account wrangler.jsonc names — a token of the wrong account, or a dead one,
 * fails before any deploy step runs.
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
    readonly CLOUDFLARE_API_TOKEN?: string;
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

/** `env.<env>` of a parsed wrangler.jsonc document ({} when absent). */
const envEntry = (config: unknown, env: string): Record<string, unknown> => {
  const envs = isObj(config) ? (objProp(config, "env") ?? {}) : {};
  return objProp(envs, env) ?? {};
};

const stringRows = (rows: ReadonlyArray<unknown>, key: string): string[] =>
  rows.filter(isObj).flatMap((row) => {
    const value = strProp(row, key);
    return value === undefined ? [] : [value];
  });

/** The values of `a` that also occur in `b`, deduplicated. */
const shared = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): string[] => {
  const other = new Set(b);
  return [...new Set(a.filter((value) => other.has(value)))];
};

/** The `id`/`preview_id` union of one env's `kv_namespaces` rows. */
const kvIds = (entry: Record<string, unknown>): string[] =>
  arrProp(entry, "kv_namespaces")
    .filter(isObj)
    .flatMap((row) =>
      [strProp(row, "id"), strProp(row, "preview_id")].filter(
        (id): id is string => id !== undefined,
      ),
    );

type WorkerRef = { readonly kind: string; readonly binding: string; readonly target: string };

/** One env's references into another Worker: DO `script_name`s and `services` targets. */
const workerRefs = (entry: Record<string, unknown>): WorkerRef[] => {
  const durableObjects = arrProp(objProp(entry, "durable_objects") ?? {}, "bindings");
  const fromObjects = durableObjects.filter(isObj).flatMap((row) => {
    const target = strProp(row, "script_name");
    return target === undefined
      ? []
      : [{ kind: "durable-object", binding: strProp(row, "name") ?? target, target }];
  });
  const fromServices = arrProp(entry, "services")
    .filter(isObj)
    .flatMap((row) => {
      const target = strProp(row, "service");
      return target === undefined
        ? []
        : [{ kind: "service", binding: strProp(row, "binding") ?? target, target }];
    });
  return [...fromObjects, ...fromServices];
};

/**
 * Every piece of state staging and production would share inside one Cloudflare account, one line
 * per item (an empty list = isolated): the Worker name, route patterns, KV ids (a shared id or
 * preview_id shares the namespace), rate-limit namespace ids (account-scoped counters) and
 * durable-object/service bindings that reach into the other env's Worker. The account id is the
 * same by design and is not compared.
 */
export function sharedState(config: unknown): string[] {
  const staging = envEntry(config, "staging");
  const production = envEntry(config, "production");
  const problems: string[] = [];

  const stagingName = strProp(staging, "name") ?? "";
  const productionName = strProp(production, "name") ?? "";
  if (stagingName === "") {
    problems.push("staging has no worker name");
  }
  if (productionName === "") {
    problems.push("production has no worker name");
  }
  if (stagingName !== "" && stagingName === productionName) {
    problems.push(`worker name "${stagingName}" is shared by staging and production`);
  }
  for (const pattern of shared(
    stringRows(arrProp(staging, "routes"), "pattern"),
    stringRows(arrProp(production, "routes"), "pattern"),
  )) {
    problems.push(`route pattern "${pattern}" is shared by staging and production`);
  }
  for (const id of shared(kvIds(staging), kvIds(production))) {
    problems.push(`kv namespace id "${id}" is shared by staging and production`);
  }
  for (const id of shared(
    stringRows(arrProp(staging, "ratelimits"), "namespace_id"),
    stringRows(arrProp(production, "ratelimits"), "namespace_id"),
  )) {
    problems.push(`rate-limit namespace "${id}" is shared by staging and production`);
  }
  const crossRefs = (
    side: string,
    entry: Record<string, unknown>,
    otherName: string,
    other: string,
  ): void => {
    for (const ref of workerRefs(entry)) {
      if (ref.target === otherName) {
        problems.push(
          `${side} ${ref.kind} binding "${ref.binding}" points at the ${other} worker ` +
            `"${ref.target}"`,
        );
      }
    }
  };
  if (productionName !== "") {
    crossRefs("staging", staging, productionName, "production");
  }
  if (stagingName !== "") {
    crossRefs("production", production, stagingName, "staging");
  }
  return problems;
}

export type EnvironmentRecord = {
  /** The JSON of `GET /repos/{repo}/environments/{name}`. */
  readonly environment: unknown;
  /** The JSON of `GET /repos/{repo}/environments/{name}/deployment-branch-policies`. */
  readonly branchPolicies: unknown;
};

const reviewerIdentity = (row: Record<string, unknown>): string | undefined => {
  const type = strProp(row, "type");
  const reviewer = objProp(row, "reviewer") ?? {};
  const id = type === "Team" ? strProp(reviewer, "slug") : strProp(reviewer, "login");
  return type === undefined || id === undefined ? undefined : `${type}:${id}`;
};

type GateSide = {
  readonly problems: string[];
  /** `Type:id` reviewer identities, when a required_reviewers rule has ≥1 reviewer. */
  readonly reviewers: ReadonlySet<string> | undefined;
  readonly preventSelfReview: unknown;
};

const gateSide = (name: string, record: EnvironmentRecord | undefined): GateSide => {
  if (record === undefined) {
    return {
      problems: [`${name}: the environment does not exist`],
      reviewers: undefined,
      preventSelfReview: undefined,
    };
  }
  const problems: string[] = [];
  const environment = isObj(record.environment) ? record.environment : {};
  let reviewers: ReadonlySet<string> | undefined;
  let preventSelfReview: unknown;
  for (const rule of arrProp(environment, "protection_rules").filter(isObj)) {
    if (strProp(rule, "type") !== "required_reviewers") {
      continue;
    }
    const identities = arrProp(rule, "reviewers")
      .filter(isObj)
      .map(reviewerIdentity)
      .filter((id): id is string => id !== undefined);
    if (identities.length > 0) {
      reviewers = new Set(identities);
      preventSelfReview = prop(rule, "prevent_self_review");
      break;
    }
  }
  if (reviewers === undefined) {
    problems.push(`${name}: no required reviewer`);
  }
  if (prop(environment, "can_admins_bypass") !== false) {
    problems.push(`${name}: administrators may bypass the protection rules`);
  }
  const policy = objProp(environment, "deployment_branch_policy") ?? {};
  if (
    prop(policy, "protected_branches") !== false ||
    prop(policy, "custom_branch_policies") !== true
  ) {
    problems.push(`${name}: the deployment branch policy is not custom branch policies only`);
  }
  const policies = isObj(record.branchPolicies)
    ? arrProp(record.branchPolicies, "branch_policies")
    : [];
  const single = policies.length === 1 && isObj(policies[0]) ? policies[0] : undefined;
  if (
    single === undefined ||
    strProp(single, "type") !== "branch" ||
    strProp(single, "name") !== "main"
  ) {
    problems.push(`${name}: the deployment branches are not exactly the main branch`);
  }
  return { problems, reviewers, preventSelfReview };
};

/**
 * The deployment environments' gate parity: with one Cloudflare account a Workers token is
 * account-wide, so an approved staging job must face exactly the production gate — the same
 * reviewer set and prevent-self-review flag, admins unable to bypass, and main as the only
 * deployable branch.
 */
export function environmentGate(envs: {
  readonly staging: EnvironmentRecord | undefined;
  readonly production: EnvironmentRecord | undefined;
}): string[] {
  const staging = gateSide("staging", envs.staging);
  const production = gateSide("production", envs.production);
  const problems = [...staging.problems, ...production.problems];
  if (staging.reviewers !== undefined && production.reviewers !== undefined) {
    const stagingReviewers = staging.reviewers;
    const productionReviewers = production.reviewers;
    const same =
      stagingReviewers.size === productionReviewers.size &&
      [...stagingReviewers].every((id) => productionReviewers.has(id));
    if (!same) {
      problems.push("staging and production require different reviewers");
    }
    if (staging.preventSelfReview !== production.preventSelfReview) {
      problems.push("staging and production differ on prevent_self_review");
    }
  }
  return problems;
}

/**
 * The verdict of Cloudflare's `GET accounts/{id}/tokens/verify`: the token is right only for an
 * active token owned by that account — anything else is a one-line reason carrying the HTTP status
 * and the token's own status when the API reports one.
 */
export function tokenProblem(status: number, body: unknown): string | undefined {
  const state = isObj(body) ? strProp(objProp(body, "result") ?? {}, "status") : undefined;
  if (status === 200 && isObj(body) && prop(body, "success") === true && state === "active") {
    return undefined;
  }
  const parts = [`HTTP ${String(status)}`];
  if (state !== undefined) {
    parts.push(`token status "${state}"`);
  }
  if (isObj(body) && prop(body, "success") === false) {
    parts.push("the API reports success: false");
  }
  return parts.join(", ");
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

type GhResult =
  | { readonly ok: true; readonly json: unknown }
  | { readonly ok: false; readonly absent: boolean; readonly stderr: string };

/** `gh api <endpoint>`; `absent` marks the API's own "HTTP 404" answer. */
const ghApi = (endpoint: string): GhResult => {
  const result = run(["gh", "api", endpoint]);
  if (result.code !== 0) {
    return {
      ok: false,
      absent: result.stderr.includes("HTTP 404"),
      stderr: result.stderr.trim().slice(0, 300),
    };
  }
  return { ok: true, json: JSON.parse(result.stdout) };
};

const environmentRecord = (
  repo: string,
  name: string,
): { ok: true; record: EnvironmentRecord | undefined } | { ok: false; error: string } => {
  const environment = ghApi(`repos/${repo}/environments/${name}`);
  if (!environment.ok) {
    return environment.absent
      ? { ok: true, record: undefined }
      : { ok: false, error: `gh api environments/${name}: ${environment.stderr}` };
  }
  const branchPolicies = ghApi(`repos/${repo}/environments/${name}/deployment-branch-policies`);
  if (!branchPolicies.ok && !branchPolicies.absent) {
    return {
      ok: false,
      error: `gh api deployment-branch-policies (${name}): ${branchPolicies.stderr}`,
    };
  }
  return {
    ok: true,
    record: {
      environment: environment.json,
      branchPolicies: branchPolicies.ok ? branchPolicies.json : undefined,
    },
  };
};

const environments = (): number => {
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo === undefined) {
    console.log("::error::GITHUB_REPOSITORY is not set");
    return 1;
  }
  const staging = environmentRecord(repo, "staging");
  if (!staging.ok) {
    console.log(`::error::${staging.error}`);
    return 1;
  }
  const production = environmentRecord(repo, "production");
  if (!production.ok) {
    console.log(`::error::${production.error}`);
    return 1;
  }
  const problems = [
    ...environmentGate({ staging: staging.record, production: production.record }),
    ...sharedState(wranglerConfig()),
  ];
  for (const problem of problems) {
    console.log(`::error::${problem}`);
  }
  if (problems.length > 0) {
    return 1;
  }
  console.log("staging and production carry the same reviewer gate and share no state");
  return 0;
};

const token = async (env: string): Promise<number> => {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (apiToken === undefined || apiToken === "") {
    console.log(`::error::the ${env} environment has no CLOUDFLARE_API_TOKEN secret`);
    return 1;
  }
  const accountId = strProp(envEntry(wranglerConfig(), env), "account_id");
  if (accountId === undefined || accountId === "") {
    console.log(`::error::wrangler.jsonc has no env.${env}.account_id`);
    return 1;
  }
  let status: number;
  let body: unknown;
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`,
      { headers: { authorization: `Bearer ${apiToken}` } },
    );
    ({ status } = response);
    body = await response.json();
  } catch (error) {
    console.log(`::error::the token verify request failed: ${String(error).slice(0, 200)}`);
    return 1;
  }
  const problem = tokenProblem(status, body);
  if (problem !== undefined) {
    console.log(
      `::error::the ${env} CLOUDFLARE_API_TOKEN is not an active token of account ` +
        `${accountId}: ${problem}`,
    );
    return 1;
  }
  console.log(`the ${env} CLOUDFLARE_API_TOKEN is an active token of account ${accountId}`);
  return 0;
};

// `import.meta.main` is set by bun only for the entry file — vitest imports the module for tests.
const meta: unknown = import.meta;
if (isObj(meta) && prop(meta, "main") === true) {
  const [command, env, commit] = process.argv.slice(2);
  if (command === "environments") {
    process.exit(environments());
  }
  if (
    (env !== "staging" && env !== "production") ||
    (command !== "secrets" && command !== "rollback-plan" && command !== "token")
  ) {
    console.error(
      "usage: deploy-check.ts secrets|rollback-plan|token <staging|production> [<commit>]\n" +
        "       deploy-check.ts environments",
    );
    process.exit(2);
  }
  if (command === "token") {
    process.exit(await token(env));
  }
  process.exit(command === "secrets" ? secrets(env) : rollbackPlan(env, commit ?? ""));
}
