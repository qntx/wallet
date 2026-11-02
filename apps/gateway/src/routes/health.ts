import { Hono } from "hono";

import { health } from "@qntx/wallet-engine/gateway/contract";

export const healthRoutes = new Hono().get(health.path, (c) => c.json({ status: "ok" as const }));
