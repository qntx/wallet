/**
 * Binds the native `__qntx.keystore` object to the kernel's `Keystore` contract. The C++ side
 * completes each call with `(bytes, code)`; a failure code is already the kernel error code
 * (`cancelled`, `factor-invalidated`, `factor-unavailable`, `unavailable`) and becomes a
 * `KernelError` so the vault reports it verbatim instead of as an integrity failure.
 */
import { KernelError } from "../../wallet-kernel/src/errors.ts";
import type { Keystore } from "../../wallet-kernel/src/platform.ts";

type Completion = (result: Uint8Array | undefined, code: string | undefined) => void;

/** The `__qntx.keystore` surface the native host injects. */
export type KernelKeystoreNative = {
  readonly locale: string;
  readonly seal: (
    id: string,
    secret: Uint8Array,
    title: string,
    description: string,
    done: Completion,
  ) => void;
  readonly open: (
    id: string,
    sealed: Uint8Array,
    title: string,
    description: string,
    done: Completion,
  ) => void;
  readonly authenticate: (title: string, description: string, done: Completion) => void;
  readonly clear: (done: Completion) => void;
};

function failure(code: string | undefined): KernelError {
  return code === "cancelled" ||
    code === "factor-invalidated" ||
    code === "factor-unavailable" ||
    code === "unavailable"
    ? new KernelError(code, "the platform keystore did not complete")
    : new KernelError("unavailable", "the platform keystore reported no outcome");
}

async function bytesOf(start: (done: Completion) => void): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    start((result, code) => {
      if (result === undefined) {
        reject(failure(code));
        return;
      }
      resolve(result);
    });
  });
}

async function outcomeOf(start: (done: Completion) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    start((_result, code) => {
      if (code !== undefined) {
        reject(failure(code));
        return;
      }
      resolve();
    });
  });
}

export function bindNativeKeystore(raw: KernelKeystoreNative): Keystore {
  return {
    locale: raw.locale,
    seal: async (id, secret, prompt) =>
      bytesOf((done) => {
        raw.seal(id, secret, prompt.title, prompt.description, done);
      }),
    open: async (id, sealed, prompt) =>
      bytesOf((done) => {
        raw.open(id, sealed, prompt.title, prompt.description, done);
      }),
    authenticate: async (prompt) =>
      outcomeOf((done) => {
        raw.authenticate(prompt.title, prompt.description, done);
      }),
    clear: async () =>
      outcomeOf((done) => {
        raw.clear(done);
      }),
  };
}
