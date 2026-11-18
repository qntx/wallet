import type { ChainSignRequest } from "@qntx/wallet/chains";

/**
 * The account a send or signature names. `@qntx/wallet` does not export this type by name; it is
 * the `account` of every chain sign request except `bitcoin.psbt`.
 */
export type AccountRef = Exclude<ChainSignRequest, { readonly kind: "bitcoin.psbt" }>["account"];
