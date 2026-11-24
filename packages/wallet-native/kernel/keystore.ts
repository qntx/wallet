/**
 * Binds the native `__qntx.keystore` object to the kernel's `Keystore` contract. The C++ side
 * completes each call with `(bytes, code, detail)`; a failure code is already the kernel error code
 * (`cancelled`, `factor-invalidated`, `verification-unavailable`, `unavailable`) and becomes a
 * `KernelError` so the vault reports it verbatim instead of as an integrity failure. Presence work
 * carries the prompt strings; device work runs silently (`sealDevice`/`openDevice`); `probe` never
 * shows UI and reports a gone key as `factor-invalidated` without result bytes.
 */
import { KernelError } from "../../wallet-kernel/src/errors.ts";
import type { Keystore } from "../../wallet-kernel/src/platform.ts";
import { detailOf } from "./detail.ts";

type Completion = (
  result: Uint8Array | undefined,
  code: string | undefined,
  detail: string | undefined,
) => void;

/** The `__qntx.keystore` surface the native host injects. */
export type KernelKeystoreNative = {
  readonly locale: string;
  /** The OS the keystore's system prompt renders on. */
  readonly platform: string;
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
  readonly sealDevice: (id: string, secret: Uint8Array, done: Completion) => void;
  readonly openDevice: (id: string, sealed: Uint8Array, done: Completion) => void;
  readonly probe: (id: string, protection: "device" | "presence", done: Completion) => void;
  readonly remove: (id: string, done: Completion) => void;
  readonly authenticate: (title: string, description: string, done: Completion) => void;
  readonly clear: (done: Completion) => void;
};

function failure(code: string | undefined, detail: string | undefined): KernelError {
  const diagnostic = detailOf(detail);
  return code === "cancelled" ||
    code === "factor-invalidated" ||
    code === "verification-unavailable" ||
    code === "unavailable"
    ? new KernelError(code, "the platform keystore did not complete", undefined, false, diagnostic)
    : new KernelError(
        "unavailable",
        "the platform keystore reported no outcome",
        undefined,
        false,
        diagnostic,
      );
}

async function bytesOf(start: (done: Completion) => void): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    start((result, code, detail) => {
      if (result === undefined) {
        reject(failure(code, detail));
        return;
      }
      resolve(result);
    });
  });
}

async function outcomeOf(start: (done: Completion) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    start((_result, code, detail) => {
      if (code !== undefined) {
        reject(failure(code, detail));
        return;
      }
      resolve();
    });
  });
}

/** A `probe` completion: `factor-invalidated` means the key is gone for good — `false`. */
async function probeOf(start: (done: Completion) => void): Promise<boolean> {
  return new Promise((resolve, reject) => {
    start((_result, code, detail) => {
      if (code === undefined) {
        resolve(true);
      } else if (code === "factor-invalidated") {
        resolve(false);
      } else {
        reject(failure(code, detail));
      }
    });
  });
}

export function bindNativeKeystore(raw: KernelKeystoreNative): Keystore {
  if (raw.platform !== "ios" && raw.platform !== "android") {
    throw new KernelError("integrity", `the platform keystore reported platform ${raw.platform}`);
  }
  return {
    locale: raw.locale,
    platform: raw.platform,
    seal: async (id, secret, use) =>
      bytesOf((done) => {
        if (use.protection === "presence") {
          raw.seal(id, secret, use.prompt.title, use.prompt.description, done);
        } else {
          raw.sealDevice(id, secret, done);
        }
      }),
    open: async (id, sealed, use) =>
      bytesOf((done) => {
        if (use.protection === "presence") {
          raw.open(id, sealed, use.prompt.title, use.prompt.description, done);
        } else {
          raw.openDevice(id, sealed, done);
        }
      }),
    probe: async (id, protection) =>
      probeOf((done) => {
        raw.probe(id, protection, done);
      }),
    remove: async (id) =>
      outcomeOf((done) => {
        raw.remove(id, done);
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
