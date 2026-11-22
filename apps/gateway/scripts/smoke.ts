/* oxlint-disable unicorn/no-process-exit -- a script: process exit is the result channel */
/**
 * Post-deploy smoke: health, the served network list, one real call per family per network. `bun
 * scripts/smoke.ts <baseUrl> <staging|production>` — exits non-zero listing every failure.
 */
import { runSmoke } from "./smoke-plan.ts";

declare const process: { readonly argv: ReadonlyArray<string>; exit: (code: number) => never };

const [baseUrl, env] = process.argv.slice(2);
if (baseUrl === undefined || (env !== "staging" && env !== "production")) {
  console.error("usage: bun scripts/smoke.ts <baseUrl> <staging|production>");
  process.exit(2);
}
const { passed, failures } = await runSmoke({ fetch: globalThis.fetch, baseUrl, env });
for (const name of passed) {
  console.log(`pass ${name}`);
}
for (const failure of failures) {
  console.log(`FAIL ${failure}`);
}
if (failures.length > 0) {
  console.error(`smoke: ${failures.length} failure(s)\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("smoke: all checks passed");
