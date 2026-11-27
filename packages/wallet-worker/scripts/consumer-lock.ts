/**
 * Regenerates the consumer scaffold's package-lock.json under the same release-age cooldown the
 * root bunfig.toml applies to bun — npm's `--min-release-age` (added in npm 11.10.0, ignored
 * silently by older npm; `--min-release-age-exclude` names a package whose own pin may be younger,
 * added in npm 11.17.0). A `name@X.Y.Z` entry in bunfig's `install.minimumReleaseAgeExcludes`
 * exempts a name here only when the expected consumer dependencies pin exactly that version — the
 * same exemption list governs both package managers, never a second copy. Run: `bun run --cwd
 * packages/wallet-worker consumer:lock`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CONSUMER, expectedDependencies, isRecord } from "./consumer-manifest.ts";

declare const Bun: {
  readonly TOML: { readonly parse: (text: string) => unknown };
  readonly semver: { readonly satisfies: (version: string, range: string) => boolean };
};

const ROOT = new URL("../../..", import.meta.url).pathname;

const MIN_NPM = "11.17.0";

const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
if (!Bun.semver.satisfies(npmVersion, `>=${MIN_NPM}`)) {
  throw new Error(
    `consumer:lock needs npm >= ${MIN_NPM}, found ${npmVersion} — older npm ignores ` +
      "--min-release-age silently, so the lockfile would carry no cooldown at all",
  );
}

const bunfig: unknown = Bun.TOML.parse(readFileSync(join(ROOT, "bunfig.toml"), "utf8"));
const install = isRecord(bunfig) ? bunfig["install"] : undefined;
const ageSeconds = isRecord(install) ? install["minimumReleaseAge"] : undefined;
if (typeof ageSeconds !== "number" || ageSeconds < 86400) {
  throw new Error(
    "bunfig.toml install.minimumReleaseAge must hold the release-age cooldown in seconds",
  );
}
const cooldownDays = Math.ceil(ageSeconds / 86400);

// A bunfig `name@X.Y.Z` exemption applies only while the consumer pins exactly that version —
// anything else would exempt every version the name ever resolves to.
const expected = expectedDependencies();
const excludes = isRecord(install) ? install["minimumReleaseAgeExcludes"] : undefined;
const exemptions: string[] = [];
if (excludes !== undefined) {
  if (!Array.isArray(excludes) || !excludes.every((e) => typeof e === "string")) {
    throw new Error("bunfig.toml install.minimumReleaseAgeExcludes must be a string array");
  }
  for (const entry of excludes) {
    const at = entry.lastIndexOf("@");
    const name = entry.slice(0, at);
    const version = entry.slice(at + 1);
    if (at > 0 && expected[name] === version) {
      exemptions.push(name);
      console.log(`cooldown exemption: ${entry} (consumer pins ${version})`);
    } else {
      console.log(`bunfig exemption ${entry} not needed by the consumer pins — ignored`);
    }
  }
}

writeFileSync(
  join(CONSUMER, "package.json"),
  `${JSON.stringify(
    {
      name: "qntx-consumer-smoke",
      private: true,
      type: "module",
      dependencies: expected,
    },
    null,
    2,
  )}\n`,
);
const lockfile = join(CONSUMER, "package-lock.json");
if (existsSync(lockfile)) {
  rmSync(lockfile);
}
execFileSync(
  "npm",
  [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `--min-release-age=${cooldownDays}`,
    ...exemptions.map((name) => `--min-release-age-exclude=${name}`),
  ],
  { cwd: CONSUMER, stdio: "inherit" },
);
console.log(
  `consumer lockfile regenerated (release-age cooldown ${cooldownDays}d` +
    `${exemptions.length > 0 ? `, exempt: ${exemptions.join(", ")}` : ""})`,
);
