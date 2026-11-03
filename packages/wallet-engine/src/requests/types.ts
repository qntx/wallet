/**
 * Request method and origin types shared by the request controller and its sign log — kept in a
 * leaf module so persistence code can name them without importing the controller.
 */
import type { ChainRequestMethod } from "../transactions/route.ts";

/** A web page; `origin` is `scheme://host[:port]`, computed by the host from the top-level URL. */
export type BrowserOrigin = { readonly kind: "browser"; readonly origin: string };

export type RequestOrigin = { readonly kind: "internal" } | BrowserOrigin;

export type RequestMethod =
  | ChainRequestMethod
  | "pay"
  | "zap"
  | "evm-sign"
  | "nostr-sign"
  | "webln-invoice"
  | "spark-deposit"
  | "spark-exit";
