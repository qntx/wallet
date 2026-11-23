/**
 * Main-runtime tap for the card-surfaces leak check. index.ts installs it
 * before App (and so before any Nitro hybrid object exists) when
 * EXPO_PUBLIC_CARD_SURFACES=1. Every console call, every hybrid-object method
 * call with its arguments and result, every SecureInput state, every React
 * state value the page reports, and every global JS error becomes one
 * `CARD_LEAK_RECORD <json>` line written through the ORIGINAL console.log, so
 * the checker can prove the secrets never cross this runtime.
 */

const originalLog = console.log.bind(console);

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// ArrayBuffers (and views) render as hex AND utf-8: any secret that ever
// passes through the main runtime leaves a fingerprint in the record.
const describeBytes = (bytes: Uint8Array): unknown => {
  let utf8: string;
  try {
    utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    utf8 = "";
  }
  return { $bytes: { length: bytes.length, hex: hex(bytes), utf8 } };
};

const describe = (value: unknown, depth: number): unknown => {
  if (depth > 4) {
    return "[depth-limit]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return describeBytes(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return describeBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (typeof value === "function") {
    return `[function ${value.name || "anonymous"}]`;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => describe(entry, depth + 1));
  }
  if (typeof value === "object") {
    try {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = describe(entry, depth + 1);
      }
      return out;
    } catch {
      return "[unserializable object]";
    }
  }
  return String(value);
};

/** Emit one audit record; the page uses it for React state and view states. */
export const recordLeak = (kind: string, data: unknown): void => {
  try {
    originalLog(`CARD_LEAK_RECORD ${JSON.stringify({ kind, data: describe(data, 0) })}`);
  } catch (error) {
    originalLog(`CARD_LEAK_RECORD ${JSON.stringify({ kind, error: String(error) })}`);
  }
};

const wrapMethod =
  (objectName: string, methodName: string, fn: (...args: unknown[]) => unknown) =>
  (...args: unknown[]): unknown => {
    recordLeak("hybrid-call", { object: objectName, method: methodName, args });
    let result: unknown;
    try {
      result = fn(...args);
    } catch (error) {
      recordLeak("hybrid-throw", {
        object: objectName,
        method: methodName,
        error: String(error),
      });
      throw error;
    }
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          recordLeak("hybrid-result", {
            object: objectName,
            method: methodName,
            result: value,
          });
          return value;
        },
        (error: unknown) => {
          recordLeak("hybrid-error", {
            object: objectName,
            method: methodName,
            error: String(error),
          });
          throw error;
        },
      );
    }
    recordLeak("hybrid-result", { object: objectName, method: methodName, result });
    return result;
  };

// Every method call on every hybrid object goes through the proxy get — the
// returned function reports before and after the native call.
const wrapHybrid = (name: string, instance: object): object =>
  new Proxy(instance, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function" || typeof prop !== "string") {
        return value;
      }
      return wrapMethod(name, prop, value.bind(target) as (...args: unknown[]) => unknown);
    },
  });

let installed = false;

/** Tee console.* and wrap NitroModules.createHybridObject. Idempotent. */
export const installLeakRecorder = (): void => {
  if (installed) {
    return;
  }
  installed = true;

  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      recordLeak(`console.${method}`, args);
      original(...args);
    };
  }

  // Loading nitro-modules installs global.NitroModulesProxy on first import;
  // doing it here keeps the wrap earlier than any other createHybridObject.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NitroModules } = require("react-native-nitro-modules") as {
    NitroModules: { createHybridObject: <T>(name: string) => T };
  };
  const originalCreate = NitroModules.createHybridObject;
  try {
    Object.defineProperty(NitroModules, "createHybridObject", {
      value: function createHybridObject<T>(name: string): T {
        return wrapHybrid(name, originalCreate.call(NitroModules, name) as object) as T;
      },
      writable: true,
      configurable: true,
    });
  } catch (error) {
    recordLeak("recorder-error", `createHybridObject not wrappable: ${String(error)}`);
  }

  const errorUtils = (
    globalThis as {
      ErrorUtils?: {
        getGlobalHandler?: () => (error: unknown, fatal?: boolean) => void;
        setGlobalHandler?: (handler: (error: unknown, fatal?: boolean) => void) => void;
      };
    }
  ).ErrorUtils;
  const previous = errorUtils?.getGlobalHandler?.();
  errorUtils?.setGlobalHandler?.((error: unknown, fatal?: boolean) => {
    recordLeak("js-error", { error: String(error), fatal: fatal === true });
    previous?.(error, fatal);
  });
};
