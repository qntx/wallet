/**
 * §38 Card wallet native surfaces: card access codes and printed short IDs are collected only
 * through the trusted `SecureInput` view — never a JS `TextInput`. The main runtime observes just
 * `idle | empty | filled | submitted` on `onStateChange`, which Nitro requires wrapped in
 * `callback`. Compiled only.
 */
import { callback } from "react-native-nitro-modules";

import { SecureInput } from "@qntx/wallet-native/secure-input";
import type { SecureInputProps, SecureInputState } from "@qntx/wallet-native/secure-input";

/** The UI text a host shows for each state the trusted field reports — exhaustive. */
export function secureInputText(state: SecureInputState): string {
  switch (state) {
    case "idle":
      return "";
    case "empty":
      return "Waiting for the card code";
    case "filled":
      return "Code entered — confirm it";
    case "submitted":
      return "Checking the code against the card";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/* `SecureInputProps["onStateChange"]` is the unwrapped handler signature; the props object the
   component actually takes wraps it in Nitro's `callback`, as the migration text prescribes. */
let current = "";
const onStateChange: SecureInputProps["onStateChange"] = (state) => {
  current = secureInputText(state);
};

/** The props a host passes to `SecureInput`. */
export const secureInputProps = { onStateChange: callback(onStateChange) };

/** The text the last `onStateChange` produced. */
export const secureInputCurrentText = (): string => current;

/** Mount this where the wallet collects the card's access code or printed short ID. */
export const secureInputView = SecureInput;
