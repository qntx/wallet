/**
 * Argon2id for the Web and Node workers. Neither WebCrypto nor node:crypto on the supported
 * runtimes offers it, so this is the audited pure-JS implementation the kernel already ships; the
 * async form yields to the event loop, so the worker keeps answering while it runs.
 */
import { argon2idAsync } from "@noble/hashes/argon2.js";

import type { Argon2id } from "@qntx/wallet-kernel";

export const nobleArgon2id: Argon2id = async (password, salt, cost, length) =>
  argon2idAsync(password, salt, {
    m: cost.memoryKiB,
    t: cost.passes,
    p: cost.lanes,
    dkLen: length,
    version: 0x13,
  });
