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
    const [name, configFactory] = getHostComponent.mock.calls[0] as [
      string,
      () => unknown,
    ];
    expect(name).toBe("SecureInputView");
    const generated = (await import(
      "../nitrogen/generated/shared/json/SecureInputViewConfig.json",
      { with: { type: "json" } }
    )) as { default: unknown };
    expect(configFactory()).toEqual(generated.default);
  });
});
