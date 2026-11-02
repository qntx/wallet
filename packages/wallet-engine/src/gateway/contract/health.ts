import * as z from "zod/mini";

import { endpoint } from "./endpoint.ts";

export const healthRequest = z.undefined();
export const healthResponse = z.object({ status: z.literal("ok") });

export const health = endpoint("GET", "/v1/health", healthRequest, healthResponse);
