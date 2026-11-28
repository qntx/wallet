import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  activeDeployment,
  commitFromMessage,
  environmentGate,
  migrationsOf,
  missingRequired,
  parseDeployments,
  parseSecretNames,
  planRollback,
  requiredSecrets,
  sharedState,
  tokenProblem,
  workerNotFound,
} from "../scripts/deploy-check.ts";
import { parseJsonc } from "../scripts/jsonc.ts";

describe("parseSecretNames", () => {
  it("reads the secret list's name rows", () => {
    expect(
      parseSecretNames(
        JSON.stringify([
          { name: "ALCHEMY_API_KEY", type: "secret_text" },
          { name: "DRPC_API_KEY", type: "secret_text" },
        ]),
      ),
    ).toStrictEqual(["ALCHEMY_API_KEY", "DRPC_API_KEY"]);
  });

  it("accepts an empty Worker secret list", () => {
    expect(parseSecretNames("[]")).toStrictEqual([]);
  });

  it.each(["{}", '["nope"]', "[{}]", '"secrets"'])("rejects %s", (output) => {
    expect(() => parseSecretNames(output)).toThrow("unexpected secret list output");
  });
});

describe("workerNotFound", () => {
  it.each([
    'Worker "wallet-gateway" (env: production) not found.\n\nIf this is a new Worker, run `wrangler deploy` first to create it.',
    'Worker "wallet-gateway" not found.',
    "[ERROR] code: 10007",
    "API request failed with status 10090",
  ])("detects %s", (stderr) => {
    expect(workerNotFound(stderr)).toBe(true);
  });

  it.each(["authentication is invalid", "code: 10001", "unknown error"])("ignores %s", (stderr) => {
    expect(workerNotFound(stderr)).toBe(false);
  });
});

describe("missingRequired", () => {
  it("lists the required names the remote lacks", () => {
    expect(missingRequired(["A", "B", "C"], ["B"])).toStrictEqual(["A", "C"]);
    expect(missingRequired(["A"], ["A", "B"])).toStrictEqual([]);
  });
});

const DEPLOYMENT = {
  id: "dep-2",
  created_on: "2026-11-20T10:00:00.000Z",
  author_email: "ci@qntx",
  source: "api",
  annotations: { "workers/message": "deploy aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  versions: [{ version_id: "ver-2", percentage: 100 }],
};

describe("parseDeployments", () => {
  it("reads id, annotation message and the serving version", () => {
    expect(parseDeployments(JSON.stringify([DEPLOYMENT]))).toStrictEqual([
      {
        id: "dep-2",
        created_on: "2026-11-20T10:00:00.000Z",
        message: "deploy aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        versionId: "ver-2",
      },
    ]);
  });

  it("picks the version holding the traffic in a split deployment", () => {
    const split = {
      ...DEPLOYMENT,
      versions: [
        { version_id: "ver-old", percentage: 90 },
        { version_id: "ver-new", percentage: 10 },
      ],
    };
    expect(parseDeployments(JSON.stringify([split]))[0]?.versionId).toBe("ver-old");
  });

  it("returns an undefined message without annotations", () => {
    const bare = { ...DEPLOYMENT, annotations: undefined };
    expect(parseDeployments(JSON.stringify([bare]))[0]?.message).toBeUndefined();
  });

  it.each(['{"id":"x"}', "[{}]"])("rejects %s", (output) => {
    expect(() => parseDeployments(output)).toThrow("unexpected");
  });

  it("rejects a deployment with no version rows", () => {
    expect(() => parseDeployments('[{"id":"d","created_on":"t","versions":[]}]')).toThrow(
      "no version rows",
    );
  });
});

describe("activeDeployment", () => {
  it("takes the newest row of the ascending list", () => {
    const older = { ...DEPLOYMENT, id: "dep-1", created_on: "2026-11-19T10:00:00.000Z" };
    const parsed = parseDeployments(JSON.stringify([older, DEPLOYMENT]));
    expect(activeDeployment(parsed)?.id).toBe("dep-2");
    expect(activeDeployment(parsed)?.id).toBe(parsed[1]?.id);
  });

  it("is undefined for no deployments", () => {
    expect(activeDeployment([])).toBeUndefined();
  });
});

describe("commitFromMessage", () => {
  it("reads the deploy annotation's 40-hex sha", () => {
    expect(commitFromMessage("deploy aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it.each([
    undefined,
    "deploy notasha",
    "deploy aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // 39
    "rollback for deploy aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ])("rejects %s", (message) => {
    expect(commitFromMessage(message)).toBeUndefined();
  });
});

describe("wrangler.jsonc rows", () => {
  const config = {
    env: {
      staging: { secrets: { required: ["ZEROX_API_KEY"] } },
      production: {
        secrets: { required: ["ZEROX_API_KEY", "ALCHEMY_API_KEY"] },
      },
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["ProviderBudgetObject"] }],
  };

  it("reads the env's required secret names", () => {
    expect(requiredSecrets(config, "production")).toStrictEqual([
      "ZEROX_API_KEY",
      "ALCHEMY_API_KEY",
    ]);
    expect(requiredSecrets(config, "staging")).toStrictEqual(["ZEROX_API_KEY"]);
    expect(requiredSecrets({ env: {} }, "production")).toStrictEqual([]);
  });

  it("reads the top-level migrations", () => {
    expect(migrationsOf(config)).toStrictEqual(config.migrations);
    expect(migrationsOf({})).toBeUndefined();
  });
});

describe("planRollback", () => {
  const deployment = {
    id: "dep-2",
    created_on: "2026-11-20T10:00:00.000Z",
    message: "deploy aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    versionId: "ver-2",
  };
  const migrations = [{ tag: "v1", new_sqlite_classes: ["ProviderBudgetObject"] }];

  it("targets the serving version when the migrations match", () => {
    expect(
      planRollback({
        deployment,
        deployedCommit: "a".repeat(40),
        newCommit: "b".repeat(40),
        oldMigrations: migrations,
        newMigrations: structuredClone(migrations),
      }),
    ).toStrictEqual({ rollbackVersion: "ver-2", reason: "ok" });
  });

  it("refuses when the migration rows differ", () => {
    const plan = planRollback({
      deployment,
      deployedCommit: "a".repeat(40),
      newCommit: "b".repeat(40),
      oldMigrations: migrations,
      newMigrations: [...migrations, { tag: "v2", new_sqlite_classes: ["Other"] }],
    });
    expect(plan.rollbackVersion).toBe("");
    expect(plan.reason).toContain("migrations differ");
  });

  it("refuses when the deployed commit is unknown", () => {
    const plan = planRollback({
      deployment,
      deployedCommit: undefined,
      newCommit: "b".repeat(40),
      oldMigrations: undefined,
      newMigrations: migrations,
    });
    expect(plan.rollbackVersion).toBe("");
    expect(plan.reason).toContain("annotation");
  });

  it("refuses when there is no previous deployment", () => {
    const plan = planRollback({
      deployment: undefined,
      deployedCommit: undefined,
      newCommit: "b".repeat(40),
      oldMigrations: undefined,
      newMigrations: migrations,
    });
    expect(plan.rollbackVersion).toBe("");
    expect(plan.reason).toContain("no previous deployment");
  });
});

describe("sharedState", () => {
  type EnvFixture = {
    name: string;
    routes: Array<{ pattern: string; custom_domain: boolean }>;
    kv_namespaces: Array<{ binding: string; id?: string; preview_id?: string }>;
    durable_objects: {
      bindings: Array<{ name: string; class_name: string; script_name?: string }>;
    };
    services?: Array<{ binding: string; service: string }>;
    ratelimits: Array<{ name: string; namespace_id: string }>;
  };
  const isolated = (): { env: { staging: EnvFixture; production: EnvFixture } } => ({
    env: {
      staging: {
        name: "wallet-gateway-staging",
        routes: [{ pattern: "staging.example.com", custom_domain: true }],
        kv_namespaces: [{ binding: "RISK", id: "staging-kv", preview_id: "staging-preview" }],
        durable_objects: { bindings: [{ name: "BUDGET", class_name: "BudgetObject" }] },
        services: [{ binding: "S", service: "helper-worker" }],
        ratelimits: [{ name: "LIMITER", namespace_id: "100" }],
      },
      production: {
        name: "wallet-gateway",
        routes: [{ pattern: "example.com", custom_domain: true }],
        kv_namespaces: [{ binding: "RISK", id: "production-kv" }],
        durable_objects: { bindings: [{ name: "BUDGET", class_name: "BudgetObject" }] },
        ratelimits: [{ name: "LIMITER", namespace_id: "200" }],
      },
    },
  });

  it("finds nothing shared in the real wrangler.jsonc", () => {
    const config = parseJsonc(
      readFileSync(new URL("../wrangler.jsonc", import.meta.url).pathname, "utf8"),
    );
    expect(sharedState(config)).toStrictEqual([]);
  });

  it("finds nothing shared between isolated envs", () => {
    expect(sharedState(isolated())).toStrictEqual([]);
  });

  it("flags one shared worker name", () => {
    const config = isolated();
    config.env.production.name = "wallet-gateway-staging";
    const problems = sharedState(config);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('worker name "wallet-gateway-staging"');
  });

  it("flags a missing worker name", () => {
    const config = isolated();
    config.env.staging.name = "";
    expect(sharedState(config)).toStrictEqual(["staging has no worker name"]);
  });

  it("flags one shared route pattern", () => {
    const config = isolated();
    config.env.staging.routes = [{ pattern: "example.com", custom_domain: true }];
    const problems = sharedState(config);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('route pattern "example.com"');
  });

  it("flags one shared kv namespace id", () => {
    const config = isolated();
    config.env.staging.kv_namespaces = [{ binding: "RISK", id: "production-kv" }];
    const problems = sharedState(config);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('kv namespace id "production-kv"');
  });

  it("flags a staging preview_id equal to the production id", () => {
    const config = isolated();
    config.env.staging.kv_namespaces = [{ binding: "RISK", preview_id: "production-kv" }];
    const problems = sharedState(config);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('kv namespace id "production-kv"');
  });

  it("flags one shared rate-limit namespace", () => {
    const config = isolated();
    config.env.production.ratelimits = [{ name: "LIMITER", namespace_id: "100" }];
    const problems = sharedState(config);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('rate-limit namespace "100"');
  });

  it("flags a durable-object binding at the other worker", () => {
    const config = isolated();
    config.env.staging.durable_objects.bindings = [
      { name: "PUSH", class_name: "PushObject", script_name: "wallet-gateway" },
    ];
    const problems = sharedState(config);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('durable-object binding "PUSH"');
    expect(problems[0]).toContain('"wallet-gateway"');
  });

  it("flags a service binding at the other worker", () => {
    const config = isolated();
    config.env.production.services = [{ binding: "S", service: "wallet-gateway-staging" }];
    const problems = sharedState(config);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('service binding "S"');
    expect(problems[0]).toContain('"wallet-gateway-staging"');
  });
});

describe("environmentGate", () => {
  type RecordFixture = {
    environment: {
      can_admins_bypass: boolean;
      protection_rules: Array<{
        id: number;
        type: string;
        prevent_self_review?: boolean;
        reviewers?: Array<{ type: string; reviewer: Record<string, unknown> }>;
      }>;
      deployment_branch_policy: {
        protected_branches: boolean;
        custom_branch_policies: boolean;
      };
    };
    branchPolicies: {
      total_count: number;
      branch_policies: Array<{ id: number; name: string; type: string }>;
    };
  };
  const record = (): RecordFixture => ({
    environment: {
      can_admins_bypass: false,
      protection_rules: [
        {
          id: 1,
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [{ type: "User", reviewer: { login: "gitctrlx", id: 76150709 } }],
        },
        { id: 2, type: "branch_policy" },
      ],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    },
    branchPolicies: {
      total_count: 1,
      branch_policies: [{ id: 3, name: "main", type: "branch" }],
    },
  });

  it("accepts two environments behind the same reviewer gate", () => {
    expect(environmentGate({ staging: record(), production: record() })).toStrictEqual([]);
  });

  it("flags a missing environment", () => {
    expect(environmentGate({ staging: undefined, production: record() })).toStrictEqual([
      "staging: the environment does not exist",
    ]);
  });

  it("flags an environment with no reviewer rule — today's live staging shape", () => {
    const staging = record();
    staging.environment.protection_rules = [{ id: 2, type: "branch_policy" }];
    expect(environmentGate({ staging, production: record() })).toStrictEqual([
      "staging: no required reviewer",
    ]);
  });

  it("flags administrators allowed to bypass", () => {
    const staging = record();
    staging.environment.can_admins_bypass = true;
    expect(environmentGate({ staging, production: record() })).toStrictEqual([
      "staging: administrators may bypass the protection rules",
    ]);
  });

  it("flags protected branches enabled in the branch policy", () => {
    const staging = record();
    staging.environment.deployment_branch_policy.protected_branches = true;
    expect(environmentGate({ staging, production: record() })).toStrictEqual([
      "staging: the deployment branch policy is not custom branch policies only",
    ]);
  });

  it("flags a second deployment branch policy", () => {
    const staging = record();
    staging.branchPolicies.branch_policies = [
      ...staging.branchPolicies.branch_policies,
      { id: 4, name: "release/*", type: "branch" },
    ];
    expect(environmentGate({ staging, production: record() })).toStrictEqual([
      "staging: the deployment branches are not exactly the main branch",
    ]);
  });

  it("flags a tag policy instead of the main branch", () => {
    const staging = record();
    staging.branchPolicies.branch_policies = [{ id: 3, name: "v*.*.*", type: "tag" }];
    expect(environmentGate({ staging, production: record() })).toStrictEqual([
      "staging: the deployment branches are not exactly the main branch",
    ]);
  });

  it("flags different reviewer sets", () => {
    const production = record();
    production.environment.protection_rules = [
      {
        id: 1,
        type: "required_reviewers",
        prevent_self_review: false,
        reviewers: [{ type: "Team", reviewer: { slug: "ops", id: 42 } }],
      },
    ];
    expect(environmentGate({ staging: record(), production })).toStrictEqual([
      "staging and production require different reviewers",
    ]);
  });

  it("flags a different prevent_self_review", () => {
    const production = record();
    production.environment.protection_rules = [
      {
        id: 1,
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "User", reviewer: { login: "gitctrlx", id: 76150709 } }],
      },
    ];
    expect(environmentGate({ staging: record(), production })).toStrictEqual([
      "staging and production differ on prevent_self_review",
    ]);
  });
});

describe("tokenProblem", () => {
  it("accepts an active token", () => {
    expect(
      tokenProblem(200, { success: true, result: { id: "t", status: "active" } }),
    ).toBeUndefined();
  });

  it("reports a refused request", () => {
    const problem = tokenProblem(401, {
      success: false,
      errors: [{ code: 9109, message: "Invalid access token" }],
    });
    expect(problem).toContain("401");
  });

  it("reports a disabled token", () => {
    const problem = tokenProblem(200, { success: true, result: { status: "disabled" } });
    expect(problem).toContain("200");
    expect(problem).toContain('"disabled"');
  });

  it("reports success: false", () => {
    expect(tokenProblem(200, { success: false, errors: [] })).toContain("success: false");
  });

  it("reports a non-object body", () => {
    expect(tokenProblem(200, "not json")).toContain("200");
  });
});
