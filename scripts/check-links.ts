// Fails when a `node_modules/@qntx/*` entry resolves outside this checkout — a leftover `bun link`
// into a sibling repo that `bun install --frozen-lockfile` does not remove. Such a link makes local
// builds and tests run unreleased code that CI and the kernel manifest never see. Undo it with
// `bun install --force`.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = realpathSync(".");
const owners = [
  ".",
  ...["packages", "apps"].flatMap((group) =>
    readdirSync(group, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(group, entry.name)),
  ),
];

const outside = owners.flatMap((owner) => {
  const scope = join(owner, "node_modules", "@qntx");
  if (!existsSync(scope)) {
    return [];
  }
  return readdirSync(scope).flatMap((name) => {
    const entry = join(scope, name);
    const target = realpathSync(entry);
    const inside = relative(root, target);
    return inside.startsWith(`..${sep}`) || inside === ".." ? [`${entry} -> ${target}`] : [];
  });
});

if (outside.length > 0) {
  process.stderr.write(
    `check-links: @qntx packages resolve outside this checkout (undo with \`bun install --force\`):\n${outside.map((line) => `  ${line}`).join("\n")}\n`,
  );
  process.exitCode = 1;
}
