import { INSTALL_ID_HEADER } from "./contract/index.ts";

export type GatewayConfig = { readonly url: string; readonly installId: string };

/** `fetch` that adds the install id to requests bound for the gateway's origin only. */
export function gatewayFetch(
  fetch: typeof globalThis.fetch,
  gateway: GatewayConfig | undefined,
): typeof globalThis.fetch {
  const origin = gateway === undefined ? undefined : new URL(gateway.url).origin;
  return async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    if (gateway === undefined || new URL(target).origin !== origin) {
      return fetch(input, init);
    }
    const headers = new Headers(init?.headers);
    headers.set(INSTALL_ID_HEADER, gateway.installId);
    return fetch(input, { ...init, headers });
  };
}
