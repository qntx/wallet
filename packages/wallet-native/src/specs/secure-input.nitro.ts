import type { HybridView, HybridViewMethods, HybridViewProps } from "react-native-nitro-modules";

/**
 * The only thing the main runtime may observe of the trusted input: `idle` when no request is
 * pending, `empty`/`filled` as the user types, and `submitted` after a confirmed entry. The main
 * runtime can mount and size this view and receive these states — it can never read the text. What
 * to collect (`access-code` or `short-id`) and the label the view shows come from the kernel's
 * `secureInput.request`, not from props.
 */
export type SecureInputState = "idle" | "empty" | "filled" | "submitted";

export interface SecureInputProps extends HybridViewProps {
  onStateChange: (state: SecureInputState) => void;
}

export interface SecureInputMethods extends HybridViewMethods {
  // No methods: nothing may drive the field from JS.
}

export type SecureInputView = HybridView<
  SecureInputProps,
  SecureInputMethods,
  { ios: "swift"; android: "kotlin" }
>;
