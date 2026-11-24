import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

const getHostComponent = vi.fn(() => "secure-input-host-component");

vi.mock("react-native-nitro-modules", () => ({
  getHostComponent,
}));

// Guard the Nitro registration: the view name must match nitro.json's
// HybridView entry and the config must be the generated JSON, so a stale
// or hand-edited copy cannot silently drift from codegen.
describe("SecureInput host component", () => {
  it("registers SecureInputView with the generated view config", async () => {
    const { SecureInput } = await import("../src/secure-input.ts");

    expect(SecureInput).toBe("secure-input-host-component");
    expect(getHostComponent).toHaveBeenCalledTimes(1);
    const [name, configFactory] = getHostComponent.mock.calls[0] as unknown as [
      string,
      () => unknown,
    ];
    expect(name).toBe("SecureInputView");
    const generated = (await import(
      "../nitrogen/generated/shared/json/SecureInputViewConfig.json",
      { with: { type: "json" } }
    )) as { default: unknown };
    expect(configFactory()).toStrictEqual(generated.default);
  });
});

/**
 * One closed kind set, in one order, declared once per layer: the kernel's union type, the C++
 * host enum, the Kotlin field ordinals, and the kernel-side `validFor` recheck. A kind added or
 * dropped on any single side desyncs every ordinal the wire depends on — this reads each
 * declaration out of its source and demands they all agree.
 */
const CANONICAL_KINDS = ["access-code", "short-id", "backup-password", "session-approval"];

const PACKAGES = join(import.meta.dirname, "../..");

const read = (path: string): string => readFileSync(join(PACKAGES, path), "utf8");

const kernelKinds = (): string[] => {
  const union = read("wallet-kernel/src/platform.ts").match(
    /export type SecureInputKind = ([^;]+);/,
  );
  if (union === null) {
    throw new Error("no SecureInputKind union in platform.ts");
  }
  return [...union[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
};

const hostKinds = (): string[] => {
  const body = read("wallet-native/cpp/host/SecureInput.hpp").match(
    /enum class SecureInputKind \{([^}]+)\}/,
  );
  if (body === null) {
    throw new Error("no SecureInputKind enum in SecureInput.hpp");
  }
  return body[1]
    .split(",")
    .map((name) => name.trim().replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase());
};

const kotlinKinds = (): string[] =>
  [...read("wallet-native/android/src/main/java/com/margelo/nitro/qntxwallet/SecureInputField.kt")
    .matchAll(/KIND_([A-Z_]+) = (\d+)/g)]
    .map((m) => ({ name: m[1]!, ordinal: Number(m[2]) }))
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(({ name }) => name.toLowerCase().replace(/_/g, "-"));

const hubKinds = (): string[] =>
  [...read("wallet-native/kernel/secure-input.ts").matchAll(/kind === "([^"]+)"/g)].map(
    (m) => m[1]!,
  );

describe("the secure-input kind set", () => {
  it("is the same ordered set in the kernel, the C++ host, Kotlin and the hub recheck", () => {
    expect(kernelKinds()).toStrictEqual(CANONICAL_KINDS);
    expect(hostKinds()).toStrictEqual(CANONICAL_KINDS);
    expect(kotlinKinds()).toStrictEqual(CANONICAL_KINDS);
    expect(hubKinds()).toStrictEqual(CANONICAL_KINDS);
  });
});
