// Fails when madge finds an import cycle in any package's src or the gateway — the audit's leaf-
// module splits stay honest instead of silently re-tangling.
import { readdirSync } from "node:fs";
import { join } from "node:path";

// The repo does not depend on @types/bun; declare the used surface.
declare const Bun: {
  spawnSync: (options: { cmd: string[]; stdout: "pipe"; stderr: "pipe" }) => {
    exitCode: number;
    stdout: { toString: () => string };
    stderr: { toString: () => string };
  };
};

const dirs = readdirSync("packages", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join("packages", entry.name, "src"));
dirs.push(join("apps", "gateway", "src"));

let failed = false;
for (const dir of dirs) {
  const result = Bun.spawnSync({
    cmd: [join("node_modules", ".bin", "madge"), "--circular", "--extensions", "ts", dir],
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) {
    process.stderr.write(`check-cycles: ${dir}: ${out.trim()}\n`);
    failed = true;
  }
}
if (failed) {
  process.exitCode = 1;
}
