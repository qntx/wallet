/* oxlint-disable no-console -- an audit script: stdout is the result channel */
import { PHISHING_SOURCES } from "../../apps/gateway/src/config/phishing.ts";
// Audit GS: measures how the live phishing sources interact once merged by buildPhishingList.
// Run from the repo root after building the engine: bun audit/gateway-supply/phishing-overlap.ts
import {
  phishingCandidates,
  phishingKey,
} from "../../packages/wallet-engine/src/gateway/contract/index.ts";

const keysOf = (entries: ReadonlyArray<string>): Set<string> => {
  const out = new Set<string>();
  for (const entry of entries) {
    const key = phishingKey(entry);
    if (key !== undefined) {
      out.add(key);
    }
  }
  return out;
};

const lists = await Promise.all(
  PHISHING_SOURCES.map(async (source) => {
    const res = await fetch(source.url);
    const parsed = source.parse(await res.json());
    return { id: source.id, deny: keysOf(parsed.deny), allow: keysOf(parsed.allow), raw: parsed };
  }),
);
const allow = new Set(lists.flatMap((l) => [...l.allow]));
const deny = new Set(lists.flatMap((l) => [...l.deny]));
for (const l of lists) {
  console.log(
    `${l.id}: raw deny=${l.raw.deny.length} allow=${l.raw.allow.length} keys deny=${l.deny.size} allow=${l.allow.size}`,
  );
}
console.log(`merged deny=${deny.size} allow=${allow.size}`);

// A deny key whose verdict is "clear" under the engine rule (most specific candidate first, allow
// wins at the same level): check the key itself as a URL, the way a page on it would be checked.
const neutralized: Array<{ key: string; denyBy: string[]; allowBy: string[]; via: string }> = [];
for (const key of deny) {
  for (const candidate of phishingCandidates(`https://${key}`)) {
    if (allow.has(candidate)) {
      neutralized.push({
        key,
        denyBy: lists.filter((l) => l.deny.has(key)).map((l) => l.id),
        allowBy: lists.filter((l) => l.allow.has(candidate)).map((l) => l.id),
        via: candidate,
      });
      break;
    }
    if (deny.has(candidate)) {
      break;
    }
  }
}
const cross = neutralized.filter((n) => !n.allowBy.some((a) => n.denyBy.includes(a)));
console.log(
  `deny keys a page on which checks clear: ${neutralized.length}; only through the other source's allow list: ${cross.length}`,
);
for (const n of cross.slice(0, 15)) {
  console.log(
    `  ${n.key} denied by ${n.denyBy.join("+")} cleared by ${n.allowBy.join("+")} via ${n.via}`,
  );
}
