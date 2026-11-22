import { getHostComponent } from "react-native-nitro-modules";
import type { ReactNativeView } from "react-native-nitro-modules";

import SecureInputViewConfig from "../nitrogen/generated/shared/json/SecureInputViewConfig.json" with { type: "json" };
import type { SecureInputMethods, SecureInputProps } from "./specs/secure-input.nitro.ts";

export type { SecureInputProps, SecureInputState } from "./specs/secure-input.nitro.ts";

/**
 * The trusted secure-input surface. Mount it where the wallet collects a card access code or short
 * ID: the kernel decides the kind and the label; the main runtime can only size the view and
 * observe `onStateChange` — it never sees the characters. `onStateChange`, like every Nitro view
 * callback, must be passed through `callback(...)`.
 */
export const SecureInput: ReactNativeView<SecureInputProps, SecureInputMethods> = getHostComponent<
  SecureInputProps,
  SecureInputMethods
>("SecureInputView", () => SecureInputViewConfig);
