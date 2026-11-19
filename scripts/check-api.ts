/**
 * API-surface snapshot: run API Extractor on every published entry point's dist `.d.mts` and
 * compare the report against the committed `api/<slug>.api.md`. An export added, removed or
 * re-signed without regenerating the report fails `check:pkg` (which packs first, so dist is
 * fresh). Re-baseline with `bun ../../scripts/check-api.ts . --update` and commit `api/`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Extractor, ExtractorConfig, ExtractorLogLevel } from "@microsoft/api-extractor";
import type { IConfigFile } from "@microsoft/api-extractor";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const dir = resolve(process.argv[2] ?? ".");
const update = process.argv.includes("--update");

const raw: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const pkg = isRecord(raw) ? raw : {};
const pkgName = typeof pkg["name"] === "string" ? pkg["name"] : dir;
const exportsMap = isRecord(pkg["exports"]) ? pkg["exports"] : {};

/** "." → index; "./gateway/contract" → gateway-contract — the report's file stem. */
const slugOf = (key: string): string =>
  key === "." ? "index" : key.replace(/^\.\//, "").replaceAll("/", "-");

type Entry = {
  readonly key: string;
  readonly slug: string;
  readonly typesPath: string;
};

const entries: Entry[] = [];
for (const [key, value] of Object.entries(exportsMap)) {
  if (key === "./package.json" || !isRecord(value)) {
    continue;
  }
  const { types } = value;
  if (typeof types !== "string") {
    continue;
  }
  entries.push({ key, slug: slugOf(key), typesPath: resolve(dir, types) });
}

const configOf = (entry: Entry): IConfigFile => ({
  projectFolder: dir,
  mainEntryPointFilePath: entry.typesPath,
  apiReport: {
    enabled: true,
    reportFolder: join(dir, "api"),
    reportFileName: `${entry.slug}.api.md`,
    reportTempFolder: temp,
    // A type reachable from an export but not exported itself is still public shape: list its
    // declaration (unexported) instead of a warning whose dist path and line move on any edit.
    includeForgottenExports: true,
  },
  docModel: { enabled: false },
  dtsRollup: { enabled: false },
  tsdocMetadata: { enabled: false },
  newlineKind: "lf",
  compiler: {
    overrideTsconfig: {
      compilerOptions: {
        target: "esnext",
        module: "esnext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: true,
      },
    },
  },
  messages: {
    extractorMessageReporting: {
      default: { logLevel: ExtractorLogLevel.None, addToApiReportFile: false },
    },
    tsdocMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
    compilerMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
  },
});

const reportDir = join(dir, "api");
// api-extractor refuses to create the report folder itself.
if (update) {
  mkdirSync(reportDir, { recursive: true });
}
const temp = mkdtempSync(join(tmpdir(), "check-api-"));
const failures: string[] = [];
try {
  for (const entry of entries) {
    const config = ExtractorConfig.prepare({
      configObject: configOf(entry),
      configObjectFullPath: undefined,
      packageJsonFullPath: join(dir, "package.json"),
    });
    const errors: string[] = [];
    // Suppress api-extractor's own console chatter; the script prints one line per entry.
    const result = Extractor.invoke(config, {
      localBuild: update,
      messageCallback: (message) => {
        if (message.logLevel === ExtractorLogLevel.Error) {
          errors.push(message.text);
        }
        message.handled = true;
      },
    });
    if (result.apiReportChanged && !update) {
      failures.push(entry.key);
    } else if (!result.succeeded) {
      throw new Error(
        `check-api ${pkgName} ${entry.key}: api-extractor failed — ${errors[0] ?? "unknown error"}`,
      );
    }
    console.log(`check-api ${pkgName} ${entry.key}: ${result.apiReportChanged ? "changed" : "ok"}`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const expected = new Set(entries.map((entry) => `${entry.slug}.api.md`));
if (existsSync(reportDir)) {
  for (const file of readdirSync(reportDir)) {
    if (!file.endsWith(".api.md") || expected.has(file)) {
      continue;
    }
    if (update) {
      rmSync(join(reportDir, file));
      console.log(`check-api ${pkgName}: deleted stale report api/${file}`);
    } else {
      failures.push(`api/${file}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(
    `check-api ${pkgName}: API drift at ${failures.join(", ")} — run \`vp pack\` then ` +
      `\`bun ../../scripts/check-api.ts . --update\` and commit its api/ folder`,
  );
}
console.log(
  update
    ? `check-api ${pkgName}: ${entries.length} entry points updated`
    : `check-api ${pkgName}: ${entries.length} entry points match api/`,
);
