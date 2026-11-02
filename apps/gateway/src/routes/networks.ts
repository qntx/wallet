import { Hono } from "hono";

import { servedNetworks } from "@qntx/wallet-engine/gateway/contract";

import type { ResolvedNetwork } from "../middleware/network.ts";

/** `GET /v1/networks` — the served network ids, in configured order. */
export function networksRoutes(served: ReadonlyMap<string, ResolvedNetwork>): Hono {
  return new Hono().get(servedNetworks.path, (c) => c.json({ networks: [...served.keys()] }));
}
