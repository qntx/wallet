import { createEventVerifier } from "@qntx/nostr";
import { signing } from "@qntx/nostr-native";

/** The libsecp256k1 verifier: the harness runs on Hermes, where the noble default is far slower. */
export const verifyEvent = createEventVerifier(signing);
