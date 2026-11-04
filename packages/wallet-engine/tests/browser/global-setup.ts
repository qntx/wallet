import { spawnSync } from "node:child_process";
import { join } from "node:path";

export default async function globalSetup(): Promise<void> {
  await Promise.resolve();
  const { status } = spawnSync(
    "bun",
    [
      "build",
      join(import.meta.dirname, "getwallets-entry.ts"),
      "--target",
      "browser",
      "--outfile",
      join(import.meta.dirname, "getwallets.js"),
    ],
    { stdio: "inherit" },
  );
  if (status !== 0) {
    throw new Error("bun build getwallets-entry.ts failed");
  }
}
