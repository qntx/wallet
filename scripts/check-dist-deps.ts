/**
 * Guard against undeclared runtime dependencies reaching the published dist: `vp pack` externals
 * every import that is not in `deps.onlyBundle`, so a src import of a package missing from
 * `dependencies`/`peerDependencies` would ship as a broken external. Scan dist/*.mjs imports and
 * require each bare specifier to be declared.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const dir = process.argv[2] ?? ".";
const raw: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const pkg = isRecord(raw) ? raw : {};
const declared = new Set<string>(
  ["dependencies", "peerDependencies", "optionalDependencies"].flatMap((key) =>
    isRecord(pkg[key]) ? Object.keys(pkg[key]) : [],
  ),
);

const specifier = (name: string): string =>
  name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : (name.split("/")[0] ?? name);

const bad = new Set<string>();
for (const file of readdirSync(join(dir, "dist"))) {
  if (!file.endsWith(".mjs")) {
    continue;
  }
  const text = readFileSync(join(dir, "dist", file), "utf8");
  for (const match of text.matchAll(/from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g)) {
    const spec = match[1] ?? match[2] ?? "";
    if (spec.startsWith(".") || spec.startsWith("node:") || spec.startsWith("bun:")) {
      continue;
    }
    const name = specifier(spec);
    if (!declared.has(name)) {
      bad.add(`${name} (${spec} in ${file})`);
    }
  }
}
if (bad.size > 0) {
  throw new Error(`undeclared imports in ${dir}/dist: ${[...bad].join(", ")}`);
}
const pkgName = typeof pkg["name"] === "string" ? pkg["name"] : dir;
console.log(`check-dist-deps ${pkgName}: all dist imports are declared`);
