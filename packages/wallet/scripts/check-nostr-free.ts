/**
 * Package check: the root entry (and every non-module subpath) must not pull a protocol library at
 * runtime — @qntx/nostr may only appear in the nostr chunk, @qntx/spark only in the spark chunk
 * (and the spark entry uses it type-only, so it must not appear at all). Walks each entry's
 * transitive relative imports and fails if any reachable file references a banned specifier.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dirname, "..", "dist");
const entries = ["index.mjs", "host.mjs", "protocol.mjs", "spark.mjs", "types.mjs"];
// Module entries whose chunk may legitimately reference their library. The spark entry's imports
// are type-only (erased in dist), so it gets no exemption — a runtime @qntx/spark reference
// anywhere is a bug.
const moduleChunks: Readonly<Record<string, string>> = {
  "nostr.mjs": "@qntx/nostr",
};
const banned = ["@qntx/nostr", "@qntx/spark"];
const visited = new Set<string>();
const offenders: string[] = [];

const visit = (file: string): void => {
  if (visited.has(file)) {
    return;
  }
  visited.add(file);
  const source = readFileSync(join(dist, file), "utf8");
  const allowed = moduleChunks[file];
  for (const specifier of banned) {
    // Import specifiers only (static `from "…"`, dynamic `import("…")`, side-effect `import "…"`):
    // doc comments that name a library are not a runtime dependency.
    const imported = new RegExp(`(?:from|import)\\s*\\(?\\s*["']${specifier}(?:/[^"']*)?["']`);
    if (specifier !== allowed && imported.test(source)) {
      offenders.push(`${file} (${specifier})`);
    }
  }
  for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    const [, spec] = match;
    if (spec !== undefined) {
      visit(spec.replace(/^\.\//, ""));
    }
  }
};

for (const entry of entries) {
  visit(entry);
}
// Every dist chunk is reachable from some entry; unknown leftovers get checked too.
for (const file of readdirSync(dist)) {
  if (file.endsWith(".mjs") && !visited.has(file)) {
    visit(file);
  }
}

if (offenders.length > 0) {
  console.error(`protocol library reachable from a foreign entry: ${offenders.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`check-module-free: ${visited.size} files clean`);
}
