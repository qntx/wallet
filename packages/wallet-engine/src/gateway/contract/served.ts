import * as z from "zod/mini";

import { endpoint } from "./endpoint.ts";
import { caip2 } from "./primitives.ts";

export const servedNetworksRequest = z.undefined();
/** The networks the gateway actually serves, in its configured order. */
export const servedNetworksResponse = z.object({ networks: z.array(caip2) });

export const servedNetworks = endpoint(
  "GET",
  "/v1/networks",
  servedNetworksRequest,
  servedNetworksResponse,
);

export const networksPath: string = servedNetworks.path;
