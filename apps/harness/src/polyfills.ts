/**
 * Round B of the engine smoke: install quick-crypto's globals (`crypto.getRandomValues`, `subtle`,
 * `Buffer`) before anything else runs. Round A leaves the runtime untouched.
 */
import { install } from "react-native-quick-crypto";

if (process.env.EXPO_PUBLIC_ENGINE_GLOBALS === "1") {
  install();
}
