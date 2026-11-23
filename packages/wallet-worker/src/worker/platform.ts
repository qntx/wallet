/** The platform fields every worker flavour shares; each host adds store/policy/backends. */
import type { KernelPlatform } from "@qntx/wallet-kernel";

import { nobleArgon2id } from "./argon2.ts";
import { subtlePbkdf2 } from "./subtle.ts";

export const basePlatform = (): Pick<
  KernelPlatform,
  | "random"
  | "now"
  | "elapsed"
  | "setTimer"
  | "pbkdf2"
  | "argon2id"
  | "keystore"
  | "passkey"
  | "card"
> => ({
  random: (length) => crypto.getRandomValues(new Uint8Array(length)),
  now: () => Date.now(),
  elapsed: () => performance.now(),
  setTimer: (delayMs, fn) => {
    const timer = setTimeout(fn, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
  pbkdf2: subtlePbkdf2,
  argon2id: nobleArgon2id,
  keystore: undefined,
  passkey: undefined,
  card: undefined,
});
