import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";

import {
  decodeHashList,
  difference,
  encodeHashList,
  phishingList,
  phishingListRequest,
  union,
} from "@qntx/wallet-engine/gateway/contract";
import type { HashList, PhishingListResponse } from "@qntx/wallet-engine/gateway/contract";

import { GatewayHttpError } from "../middleware/errors.ts";
import { SNAPSHOT_KEY, readJournal } from "../risk/phishing.ts";
import type { JournalEntry, RiskStore } from "../risk/phishing.ts";

type Net = { readonly add: HashList; readonly remove: HashList };

const EMPTY: Net = { add: new Uint8Array(), remove: new Uint8Array() };

/** Folds one more step (add, remove) into the net change: an add cancels a pending remove. */
const fold = (net: Net, step: Net): Net => ({
  add: union(difference(net.add, step.remove), difference(step.add, net.remove)),
  remove: union(difference(net.remove, step.add), difference(step.remove, net.add)),
});

const decodeStep = (step: JournalEntry["deny"]): Net | undefined => {
  const add = decodeHashList(step.add);
  const remove = decodeHashList(step.remove);
  return add === undefined || remove === undefined ? undefined : { add, remove };
};

const encode = (net: Net): JournalEntry["deny"] => ({
  add: encodeHashList(net.add),
  remove: encodeHashList(net.remove),
});

/** One net diff from `since` to the journal's head, or `undefined` when the chain is unavailable. */
function foldFrom(
  entries: ReadonlyArray<JournalEntry>,
  since: number,
): Extract<PhishingListResponse, { kind: "diff" }> | undefined {
  const start = entries.findIndex((entry) => entry.from === since);
  if (start === -1) {
    return undefined;
  }
  let deny = EMPTY;
  let allow = EMPTY;
  let cursor = since;
  for (const entry of entries.slice(start)) {
    const denyStep = decodeStep(entry.deny);
    const allowStep = decodeStep(entry.allow);
    if (entry.from !== cursor || denyStep === undefined || allowStep === undefined) {
      return undefined;
    }
    deny = fold(deny, denyStep);
    allow = fold(allow, allowStep);
    cursor = entry.version;
  }
  return { kind: "diff", from: since, version: cursor, deny: encode(deny), allow: encode(allow) };
}

/** `GET /v1/risk/lists/phishing` — the hashed phishing list as a snapshot, a net diff or `current`. */
export function riskRoutes(store: RiskStore): Hono {
  return new Hono().get(
    phishingList.path,
    sValidator("query", phishingListRequest, (result) => {
      if (!result.success) {
        throw new GatewayHttpError(400, "invalid-request");
      }
    }),
    async (c) => {
      const snapshot = async (): Promise<Response> => {
        const stored = await store.get(SNAPSHOT_KEY);
        if (stored === undefined) {
          throw new GatewayHttpError(503, "unavailable");
        }
        return c.body(stored, 200, { "content-type": "application/json" });
      };

      const { since } = c.req.valid("query");
      if (since === undefined) {
        return snapshot();
      }
      const known = Number(since);
      const journal = await readJournal(store);
      if (journal === undefined) {
        return snapshot();
      }
      if (journal.version === known) {
        return c.json({ kind: "current", version: known });
      }
      const diff = foldFrom(journal.entries, known);
      return diff === undefined ? snapshot() : c.json(diff);
    },
  );
}
