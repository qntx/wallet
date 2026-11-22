import { describe, expect, it } from "vite-plus/test";

import {
  activeDeployment,
  commitFromMessage,
  migrationsOf,
  missingRequired,
  parseDeployments,
  parseSecretNames,
  planRollback,
  requiredSecrets,
  workerNotFound,
} from "../scripts/deploy-check.ts";

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
