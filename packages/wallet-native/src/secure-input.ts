import { getHostComponent } from "react-native-nitro-modules";
import type { ReactNativeView, ViewConfig } from "react-native-nitro-modules";

import type { SecureInputMethods, SecureInputProps } from "./specs/secure-input.nitro.ts";

/**
 * The trusted secure-input surface. Mount it where the wallet collects a card access code or short
 * ID: the kernel decides the kind and the label; the main runtime can only size the view and
 * observe `onStateChange` — it never sees the characters. `onStateChange`, like every Nitro view
 * callback, must be passed through `callback(...)`.
 */
export const SecureInput: ReactNativeView<SecureInputProps, SecureInputMethods> = getHostComponent<
  SecureInputProps,
  SecureInputMethods
>(
  "SecureInputView",
  // Mirrors nitrogen/generated/shared/json/SecureInputViewConfig.json — inlined because the
  // Vitest transform cannot parse the JSON `with` import attribute.
  () => viewConfig,
);

const viewConfig: ViewConfig<SecureInputProps> = {
  uiViewClassName: "SecureInputView",
  supportsRawText: false,
  bubblingEventTypes: {},
  directEventTypes: {},
  // hybridRef is auto-handled by the view manager; the JSON config lists it
  // but it is not a user-settable prop in the type.
  validAttributes: { onStateChange: true },
};
